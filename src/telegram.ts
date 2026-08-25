import type {
  InboundMessengerMessage,
  MessengerAdapter,
  MessengerInlineKeyboard,
  MessengerMessageHandle,
  SendTextOptions,
} from './types.js';

const TELEGRAM_TEXT_LIMIT = 4_096;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const POLL_BATCH_LIMIT = 32;
const MAX_PENDING_HANDLERS = 64;
const HANDLER_DRAIN_TIMEOUT_MS = 5_000;
const ALLOWED_UPDATES = ['message', 'callback_query'] as const;
const BOT_COMMANDS = [
  { command: 'start', description: 'Start or show controls' },
  { command: 'menu', description: 'Show the control menu' },
  { command: 'sessions', description: 'List sessions' },
  { command: 'resume', description: 'Resume a session' },
  { command: 'new', description: 'Start a new session' },
  { command: 'status', description: 'Show current status' },
  { command: 'model', description: 'Choose a model' },
  { command: 'reasoning', description: 'Set reasoning effort' },
  { command: 'permission', description: 'Set permission mode' },
  { command: 'context', description: 'Show context usage' },
  { command: 'steer', description: 'Send steering instructions' },
  { command: 'cancel', description: 'Cancel the current operation' },
  { command: 'unbind', description: 'Unbind the current session' },
  { command: 'help', description: 'Show command help' },
] as const;

interface TelegramUser {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
}

interface TelegramChat {
  readonly id: number;
  readonly type: 'private' | 'group' | 'supergroup' | 'channel';
}

interface TelegramMessage {
  readonly message_id: number;
  readonly text?: string;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
}

interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage;
  readonly data?: string;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

interface TelegramResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
  readonly parameters?: {
    readonly retry_after?: number;
  };
}

interface TelegramSentMessage {
  readonly message_id: number;
}

export interface TelegramAdapterOptions {
  readonly token: string | (() => Promise<string>);
  readonly pollTimeoutSeconds: number;
  readonly requestTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  readonly onError?: (error: unknown, retryDelayMs: number) => void;
}

export class TelegramApiError extends Error {
  readonly errorCode?: number;
  readonly retryAfter?: number;
  readonly error_code?: number;
  readonly retry_after?: number;

  constructor(
    operation: string,
    readonly description: string,
    details: { readonly errorCode?: number; readonly retryAfter?: number } = {},
  ) {
    super(`Telegram ${operation} failed: ${description}`);
    this.name = 'TelegramApiError';
    if (details.errorCode !== undefined) {
      this.errorCode = details.errorCode;
      this.error_code = details.errorCode;
    }
    if (details.retryAfter !== undefined) {
      this.retryAfter = details.retryAfter;
      this.retry_after = details.retryAfter;
    }
  }
}

export function splitTelegramText(
  text: string,
  limit = TELEGRAM_TEXT_LIMIT,
): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Telegram text limit must be a positive safe integer');
  }
  const remaining = Array.from(text);
  if (remaining.length <= limit) return [text];

  const chunks: string[] = [];
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const newline = window.lastIndexOf('\n');
    const whitespace = window.lastIndexOf(' ');
    const preferred = Math.max(newline, whitespace);
    const splitAt = preferred > 0 ? preferred : limit;
    chunks.push(remaining.splice(0, splitAt).join('').trimEnd());
    while (remaining[0] === ' ' || remaining[0] === '\n') remaining.shift();
  }
  if (remaining.length > 0) chunks.push(remaining.join(''));
  return chunks;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const rejectForAbort = (): void => {
      reject(signal.reason ?? new Error('Telegram operation aborted'));
    };
    if (signal.aborted) {
      rejectForAbort();
      return;
    }
    signal.addEventListener('abort', rejectForAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', rejectForAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', rejectForAbort);
        reject(error);
      },
    );
  });
}

function senderName(user: TelegramUser | undefined): string | undefined {
  if (user === undefined) return undefined;
  if (user.username) return `@${user.username}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return name || undefined;
}

function replyMarkup(keyboard: MessengerInlineKeyboard | undefined):
  | { readonly inline_keyboard: object[][] }
  | undefined {
  if (keyboard === undefined) return undefined;
  return {
    inline_keyboard: keyboard.map((row) => row.map((button) => (
      'callbackData' in button
        ? { text: button.text, callback_data: button.callbackData }
        : { text: button.text, url: button.url }
    ))),
  };
}

function sortedUniqueUpdates(updates: readonly TelegramUpdate[]): TelegramUpdate[] {
  const byId = new Map<number, TelegramUpdate>();
  for (const update of updates) byId.set(update.update_id, update);
  return [...byId.values()].sort(
    (left, right) => left.update_id - right.update_id,
  );
}

function normalizeGroupCommand(
  text: string,
  chatKind: TelegramChat['type'],
  botUsername: string | undefined,
): string {
  if (
    botUsername === undefined
    || (chatKind !== 'group' && chatKind !== 'supergroup')
  ) return text;

  return text.replace(
    /^(\s*\/[A-Za-z0-9_]+)@([A-Za-z0-9_]+)(?=\s|$)/,
    (matched, command: string, suffix: string) => (
      suffix.toLowerCase() === botUsername.toLowerCase()
        ? command
        : matched
    ),
  );
}

function inboundUpdate(
  update: TelegramUpdate,
  botUsername: string | undefined,
): InboundMessengerMessage | undefined {
  const message = update.message;
  if (message?.text !== undefined) {
    const name = senderName(message.from);
    return {
      kind: 'message',
      transport: 'telegram',
      messageId: String(message.message_id),
      chatId: String(message.chat.id),
      chatKind: message.chat.type,
      senderId: String(message.from?.id ?? message.chat.id),
      ...(name === undefined ? {} : { senderName: name }),
      text: normalizeGroupCommand(
        message.text,
        message.chat.type,
        botUsername,
      ),
    };
  }

  const callback = update.callback_query;
  if (callback?.message === undefined || callback.data === undefined) {
    return undefined;
  }
  const name = senderName(callback.from);
  return {
    kind: 'callback_query',
    transport: 'telegram',
    messageId: String(callback.message.message_id),
    chatId: String(callback.message.chat.id),
    chatKind: callback.message.chat.type,
    senderId: String(callback.from.id),
    ...(name === undefined ? {} : { senderName: name }),
    text: callback.data,
    callbackQueryId: callback.id,
    data: callback.data,
  };
}

export class TelegramAdapter implements MessengerAdapter {
  readonly id = 'telegram';
  private readonly fetchImpl: typeof globalThis.fetch;
  private botUsername: string | undefined;
  private commandsRegistered = false;

  constructor(private readonly options: TelegramAdapterOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async validate(signal?: AbortSignal): Promise<void> {
    await this.loadBotUsername(signal);
    await this.registerCommands(signal);
  }

  async start(
    onMessage: (message: InboundMessengerMessage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let offset: number | undefined;
    let retryDelay = DEFAULT_RETRY_DELAY_MS;
    let retained: TelegramUpdate[] = [];
    const chatTails = new Map<string, Promise<void>>();
    const queued = new Set<Promise<void>>();

    const reportError = (error: unknown, delay: number): void => {
      try {
        this.options.onError?.(error, delay);
      } catch {
        // Error reporting must not stop polling or a chat queue.
      }
    };
    const waitForCapacity = async (incoming: number): Promise<void> => {
      while (queued.size + incoming > MAX_PENDING_HANDLERS) {
        if (signal.aborted) throw signal.reason;
        const pending = [...queued];
        if (pending.length === 0) return;
        await raceWithAbort(Promise.race(pending), signal);
      }
    };
    const enqueue = (message: InboundMessengerMessage): void => {
      // Callback queries bypass a blocked chat tail so answerCallbackQuery and
      // cancellation buttons remain responsive. Opaque one-use actions in the
      // bridge provide their own replay and binding fences.
      if (message.kind === 'callback_query') {
        const current = onMessage(message)
          .catch((error: unknown) => reportError(error, 0));
        queued.add(current);
        void current.finally(() => queued.delete(current));
        return;
      }
      const previous = chatTails.get(message.chatId) ?? Promise.resolve();
      const current = previous
        .then(() => onMessage(message))
        .catch((error: unknown) => reportError(error, 0));
      chatTails.set(message.chatId, current);
      queued.add(current);
      void current.finally(() => {
        queued.delete(current);
        if (chatTails.get(message.chatId) === current) {
          chatTails.delete(message.chatId);
        }
      });
    };

    try {
      if (this.botUsername === undefined) await this.loadBotUsername(signal);
      if (!this.commandsRegistered) await this.registerCommands(signal);
      while (!signal.aborted) {
        try {
          const fetched = retained.length > 0
            ? retained
            : await this.call<TelegramUpdate[]>(
              'getUpdates',
              {
                ...(offset === undefined ? {} : { offset }),
                timeout: this.options.pollTimeoutSeconds,
                limit: POLL_BATCH_LIMIT,
                allowed_updates: ALLOWED_UPDATES,
              },
              signal,
            );
          const batch = sortedUniqueUpdates(fetched);
          retained = [];
          retryDelay = DEFAULT_RETRY_DELAY_MS;
          if (batch.length === 0) continue;

          const last = batch[batch.length - 1];
          if (last === undefined) continue;
          const nextOffset = last.update_id + 1;
          // Apply backpressure before acknowledgement so confirmed, process-local
          // work stays bounded. Unadmitted updates remain recoverable by Telegram.
          await waitForCapacity(batch.length);
          // Confirm the whole fetched batch before any handler can execute. The
          // confirmation can itself return updates, which become the next batch
          // rather than being discarded.
          retained = await this.call<TelegramUpdate[]>(
            'getUpdates',
            {
              offset: nextOffset,
              timeout: 0,
              limit: POLL_BATCH_LIMIT,
              allowed_updates: ALLOWED_UPDATES,
            },
            signal,
          );
          offset = nextOffset;

          for (const update of batch) {
            const message = inboundUpdate(update, this.botUsername);
            if (message !== undefined) enqueue(message);
          }
          // Let newly queued handlers start without waiting for their completion.
          await Promise.resolve();
        } catch (error) {
          if (signal.aborted) break;
          const delay = error instanceof TelegramApiError
            && error.retryAfter !== undefined
            ? error.retryAfter * 1_000
            : retryDelay;
          reportError(error, delay);
          await abortableDelay(delay, signal);
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (queued.size > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled([...queued]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, HANDLER_DRAIN_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  async sendText(
    chatId: string,
    text: string,
    options: SendTextOptions = {},
  ): Promise<MessengerMessageHandle> {
    let first: MessengerMessageHandle | undefined;
    const markup = replyMarkup(options.keyboard);
    for (const [index, chunk] of splitTelegramText(text).entries()) {
      const sent = await this.call<TelegramSentMessage>('sendMessage', {
        chat_id: chatId,
        text: chunk,
        ...(index === 0 && markup !== undefined ? { reply_markup: markup } : {}),
      });
      first ??= { chatId, messageId: String(sent.message_id) };
    }
    // splitTelegramText always returns at least one chunk, including for ''.
    return first!;
  }

  async editText(
    chatId: string,
    messageId: string,
    text: string,
    keyboard?: MessengerInlineKeyboard,
  ): Promise<void> {
    if (Array.from(text).length > TELEGRAM_TEXT_LIMIT) {
      throw new RangeError('Telegram edited text exceeds 4096 characters');
    }
    const markup = replyMarkup(keyboard);
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(markup === undefined ? {} : { reply_markup: markup }),
      });
    } catch (error) {
      if (
        error instanceof TelegramApiError
        && error.description.toLowerCase().includes('message is not modified')
      ) return;
      throw error;
    }
  }

  async answerCallback(
    callbackQueryId: string,
    text?: string,
    showAlert?: boolean,
  ): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text === undefined ? {} : { text }),
      ...(showAlert === undefined ? {} : { show_alert: showAlert }),
    });
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.call('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    });
  }

  private async loadBotUsername(signal?: AbortSignal): Promise<void> {
    const bot = await this.call<TelegramUser>('getMe', {}, signal);
    this.botUsername = bot.username?.replace(/^@/, '');
  }

  private async registerCommands(signal?: AbortSignal): Promise<void> {
    await this.call('setMyCommands', { commands: BOT_COMMANDS }, signal);
    this.commandsRegistered = true;
  }

  private async call<T>(
    operation: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const pollSeconds = operation === 'getUpdates'
      && 'timeout' in body
      && typeof body.timeout === 'number'
      ? body.timeout
      : 0;
    const timeoutMs = pollSeconds * 1_000 + this.options.requestTimeoutMs;
    const signals = [
      this.options.signal,
      signal,
      AbortSignal.timeout(timeoutMs),
    ].filter((candidate): candidate is AbortSignal => candidate !== undefined);
    const requestSignal = AbortSignal.any(signals);
    if (requestSignal.aborted) throw requestSignal.reason;
    const token = typeof this.options.token === 'string'
      ? this.options.token
      : await raceWithAbort(this.options.token(), requestSignal);

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.telegram.org/bot${token}/${operation}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: requestSignal,
        },
      );
    } catch (error) {
      if (requestSignal.aborted) throw error;
      throw new TelegramApiError(operation, 'network request failed');
    }

    let payload: TelegramResponse<T> | undefined;
    try {
      payload = (await response.json()) as TelegramResponse<T>;
    } catch {
      // Fall through to the sanitized HTTP error below.
    }
    if (!response.ok || payload === undefined || !payload.ok) {
      throw new TelegramApiError(
        operation,
        payload?.description ?? `HTTP ${response.status}`,
        {
          ...(payload?.error_code === undefined
            ? {}
            : { errorCode: payload.error_code }),
          ...(payload?.parameters?.retry_after === undefined
            ? {}
            : { retryAfter: payload.parameters.retry_after }),
        },
      );
    }
    if (payload.result === undefined) {
      throw new TelegramApiError(operation, 'unknown API error');
    }
    return payload.result;
  }
}
