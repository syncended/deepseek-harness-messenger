import type {
  InboundMessengerMessage,
  InboundVoiceMessage,
  MessengerAdapter,
  MessengerInlineKeyboard,
  MessengerMessageHandle,
  SendTextOptions,
} from './types.js';

const TELEGRAM_TEXT_LIMIT = 4_096;
const TELEGRAM_VOICE_BYTE_LIMIT = 20 * 1024 * 1024;
const MAX_VOICE_DOWNLOAD_TIMEOUT_MS = 60_000;
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
  { command: 'voice_cancel', description: 'Cancel pending voice transcription' },
  { command: 'unbind', description: 'Unbind the current session' },
  { command: 'notifications', description: 'Notifications on/off, independent of selected session' },
  { command: 'help', description: 'Show command help' },
] as const;

interface TelegramUser {
  readonly id: number;
  readonly is_bot?: boolean;
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
  readonly sender_chat?: unknown;
  readonly voice?: {
    readonly file_id: string;
    readonly duration: number;
    readonly file_size?: number;
    readonly mime_type?: string;
  };
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

function escapeTelegramHtml(value: string, attribute = false): string {
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return attribute ? escaped.replaceAll('"', '&quot;') : escaped;
}

function markdownUrlEnd(source: string, start: number): number {
  let depth = 1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function renderTelegramInline(source: string): string {
  let rendered = '';
  let index = 0;
  const wrap = (delimiter: string, openTag: string, closeTag = openTag): boolean => {
    if (!source.startsWith(delimiter, index)) return false;
    const end = source.indexOf(delimiter, index + delimiter.length);
    if (end <= index + delimiter.length) return false;
    rendered += `<${openTag}>${renderTelegramInline(source.slice(index + delimiter.length, end))}</${closeTag}>`;
    index = end + delimiter.length;
    return true;
  };

  while (index < source.length) {
    if (
      source[index] === '\\'
      && index + 1 < source.length
      && /[\\`*_[\]{}()#+\-.!|>]/.test(source[index + 1]!)
    ) {
      rendered += escapeTelegramHtml(source[index + 1]!);
      index += 2;
      continue;
    }
    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1);
      if (end > index + 1) {
        rendered += `<code>${escapeTelegramHtml(source.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }
    if (source[index] === '[') {
      const labelEnd = source.indexOf('](', index + 1);
      const urlEnd = labelEnd < 0 ? -1 : markdownUrlEnd(source, labelEnd + 2);
      if (labelEnd > index + 1 && urlEnd > labelEnd + 2) {
        const label = source.slice(index + 1, labelEnd);
        const url = source.slice(labelEnd + 2, urlEnd).trim();
        if (/^(?:https?:\/\/|tg:\/\/|mailto:)/i.test(url)) {
          rendered += `<a href="${escapeTelegramHtml(url, true)}">${renderTelegramInline(label)}</a>`;
        } else {
          rendered += `${renderTelegramInline(label)} (${escapeTelegramHtml(url)})`;
        }
        index = urlEnd + 1;
        continue;
      }
    }
    if (
      wrap('**', 'b')
      || wrap('__', 'b')
      || wrap('~~', 's')
      || wrap('||', 'span class="tg-spoiler"', 'span')
      || wrap('*', 'i')
    ) continue;

    rendered += escapeTelegramHtml(source[index]!);
    index += 1;
  }
  return rendered;
}

/** Convert common model Markdown into Telegram's supported HTML subset. */
export function renderTelegramMarkdown(text: string): string {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const rendered: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = line.match(/^\s*```\s*([A-Za-z0-9_+.-]*)\s*$/);
    if (fence !== null) {
      const code: string[] = [];
      while (index + 1 < lines.length && !/^\s*```\s*$/.test(lines[index + 1]!)) {
        index += 1;
        code.push(lines[index]!);
      }
      if (index + 1 < lines.length) index += 1;
      const language = fence[1]
        ? ` class="language-${escapeTelegramHtml(fence[1], true)}"`
        : '';
      rendered.push(`<pre><code${language}>${escapeTelegramHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [line.replace(/^\s*>\s?/, '')];
      while (index + 1 < lines.length && /^\s*>\s?/.test(lines[index + 1]!)) {
        index += 1;
        quote.push(lines[index]!.replace(/^\s*>\s?/, ''));
      }
      rendered.push(`<blockquote>${quote.map(renderTelegramInline).join('\n')}</blockquote>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading !== null) {
      rendered.push(`<b>${renderTelegramInline(heading[1]!)}</b>`);
      continue;
    }
    const bullet = line.match(/^\s*[-+*]\s+(.+)$/);
    if (bullet !== null) {
      rendered.push(`• ${renderTelegramInline(bullet[1]!)}`);
      continue;
    }
    rendered.push(renderTelegramInline(line));
  }

  return rendered.join('\n');
}

function telegramHtmlVisibleLength(html: string): number {
  const tokens = html.match(/<[^>]+>|&(?:#\d+|#x[\da-f]+|[a-z]+);|[^<&]+|[<&]/gi) ?? [];
  let length = 0;
  for (const token of tokens) {
    if (token.startsWith('<')) continue;
    length += /^&(?:#\d+|#x[\da-f]+|[a-z]+);$/i.test(token) ? 1 : token.length;
  }
  return length;
}

interface OpenHtmlTag {
  readonly source: string;
  readonly name: string;
}

/** Split generated Telegram HTML while closing and reopening formatting tags. */
export function splitTelegramHtml(
  html: string,
  limit = TELEGRAM_TEXT_LIMIT,
): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Telegram text limit must be a positive safe integer');
  }
  const tokens = html.match(/<[^>]+>|&(?:#\d+|#x[\da-f]+|[a-z]+);|[^<&]+|[<&]/gi) ?? [];
  const chunks: string[] = [];
  const open: OpenHtmlTag[] = [];
  let current = '';
  let visible = 0;

  const closeTags = (): string => [...open]
    .reverse()
    .map((tag) => `</${tag.name}>`)
    .join('');
  const reopenTags = (): string => open.map((tag) => tag.source).join('');
  const flush = (): void => {
    if (!current) return;
    chunks.push(`${current}${closeTags()}`);
    current = reopenTags();
    visible = 0;
  };
  const appendVisible = (value: string, width: number): void => {
    if (visible > 0 && visible + width > limit) flush();
    current += value;
    visible += width;
  };

  for (const token of tokens) {
    if (token.startsWith('<')) {
      const closing = token.match(/^<\/([a-z0-9-]+)>$/i);
      if (closing !== null) {
        current += token;
        const last = open.at(-1);
        if (last?.name.toLowerCase() === closing[1]!.toLowerCase()) open.pop();
        continue;
      }
      const opening = token.match(/^<([a-z0-9-]+)(?:\s[^>]*)?>$/i);
      if (opening !== null) {
        current += token;
        open.push({ source: token, name: opening[1]! });
        continue;
      }
      appendVisible(escapeTelegramHtml(token), token.length);
      continue;
    }
    if (/^&(?:#\d+|#x[\da-f]+|[a-z]+);$/i.test(token)) {
      appendVisible(token, 1);
      continue;
    }
    for (const character of token) appendVisible(character, character.length);
  }
  if (current) chunks.push(`${current}${closeTags()}`);
  return chunks.length > 0 ? chunks : [''];
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
    if (signal.aborted) rejectForAbort();
    else signal.addEventListener('abort', rejectForAbort, { once: true });
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

function validVoiceSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Never reflect Telegram URLs, credentials, or raw transport errors. */
function safeApiDescription(value: unknown, token: string, status: number): string {
  if (typeof value !== 'string') return `HTTP ${status}`;
  const withoutUrls = value.replace(/https?:\/\/[^\s<>"']+/gi, '[redacted URL]');
  return (token ? withoutUrls.split(token).join('[redacted]') : withoutUrls)
    .replace(/\b\d{5,}:[A-Za-z0-9_-]+\b/g, '[redacted]');
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

  if (message?.voice !== undefined) {
    const voice = message.voice;
    const user = message.from;
    if (
      voice === null
      || user == null
      || !Number.isSafeInteger(user.id) || user.id <= 0
      || user.is_bot === true || message.sender_chat !== undefined
      || typeof voice.file_id !== 'string' || voice.file_id.trim() === ''
      || typeof voice.duration !== 'number'
      || !Number.isFinite(voice.duration) || voice.duration < 0
      || (voice.file_size !== undefined && !validVoiceSize(voice.file_size))
    ) return undefined;
    const name = senderName(user);
    return {
      kind: 'voice',
      transport: 'telegram',
      messageId: String(message.message_id),
      chatId: String(message.chat.id),
      chatKind: message.chat.type,
      senderId: String(user.id),
      ...(name === undefined ? {} : { senderName: name }),
      text: '',
      voice: {
        fileId: voice.file_id,
        durationSeconds: voice.duration,
        ...(voice.file_size === undefined ? {} : { sizeBytes: voice.file_size }),
        ...(typeof voice.mime_type === 'string' ? { mimeType: voice.mime_type } : {}),
      },
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
  readonly textLimit = TELEGRAM_TEXT_LIMIT;
  private readonly fetchImpl: typeof globalThis.fetch;
  private botUsername: string | undefined;
  private commandsRegistered = false;

  constructor(private readonly options: TelegramAdapterOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  textLength(text: string): number {
    return telegramHtmlVisibleLength(renderTelegramMarkdown(text));
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
    const chunks = splitTelegramHtml(renderTelegramMarkdown(text));
    let first: MessengerMessageHandle | undefined;
    for (const [index, chunk] of chunks.entries()) {
      const handle = await this.sendHtmlText(
        chatId,
        chunk,
        index === 0 ? options.keyboard : undefined,
      );
      first ??= handle;
    }
    return first!;
  }

  async editText(
    chatId: string,
    messageId: string,
    text: string,
    keyboard?: MessengerInlineKeyboard,
  ): Promise<void> {
    const chunks = splitTelegramHtml(renderTelegramMarkdown(text));
    if (chunks.length !== 1) {
      throw new RangeError('Telegram edited text exceeds 4096 visible characters');
    }
    await this.editHtmlText(chatId, messageId, chunks[0]!, keyboard);
  }

  async replaceText(
    chatId: string,
    messageId: string,
    text: string,
    keyboard?: MessengerInlineKeyboard,
  ): Promise<void> {
    const chunks = splitTelegramHtml(renderTelegramMarkdown(text));
    await this.editHtmlText(chatId, messageId, chunks[0]!, keyboard);
    for (const chunk of chunks.slice(1)) await this.sendHtmlText(chatId, chunk);
  }

  private async sendHtmlText(
    chatId: string,
    html: string,
    keyboard?: MessengerInlineKeyboard,
  ): Promise<MessengerMessageHandle> {
    const markup = replyMarkup(keyboard);
    const sent = await this.call<TelegramSentMessage>('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      ...(markup === undefined ? {} : { reply_markup: markup }),
    });
    return { chatId, messageId: String(sent.message_id) };
  }

  private async editHtmlText(
    chatId: string,
    messageId: string,
    html: string,
    keyboard?: MessengerInlineKeyboard,
  ): Promise<void> {
    const markup = replyMarkup(keyboard);
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: 'HTML',
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

  async downloadVoice(message: InboundVoiceMessage, signal: AbortSignal): Promise<Uint8Array> {
    const operation = 'downloadVoice';
    const configuredTimeout = this.options.requestTimeoutMs;
    const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(Math.floor(configuredTimeout), MAX_VOICE_DOWNLOAD_TIMEOUT_MS)
      : MAX_VOICE_DOWNLOAD_TIMEOUT_MS;
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([
      signal,
      ...(this.options.signal === undefined ? [] : [this.options.signal]),
      AbortSignal.timeout(timeout),
      controller.signal,
    ]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let downloadToken = typeof this.options.token === 'string' ? this.options.token : '';
    const checkSize = (size: unknown): void => {
      if (size === undefined) return;
      if (!validVoiceSize(size)) throw new TelegramApiError(operation, 'invalid voice size');
      if (size > TELEGRAM_VOICE_BYTE_LIMIT) {
        throw new TelegramApiError(operation, 'voice exceeds 20 MB limit');
      }
    };
    try {
      requestSignal.throwIfAborted();
      checkSize(message.voice.sizeBytes);
      const file = await raceWithAbort(this.call<{
        file_path?: unknown;
        file_size?: unknown;
      }>('getFile', { file_id: message.voice.fileId }, requestSignal), requestSignal);
      checkSize(file.file_size);
      const path = file.file_path;
      // Accept only relative Telegram file paths, never URLs, encoded separators,
      // dot segments, queries, fragments, backslashes, or redirect destinations.
      if (
        typeof path !== 'string' || path.length > 1024
        || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(path)
      ) throw new TelegramApiError(operation, 'invalid Telegram file path');
      const token = await this.resolveToken(operation, requestSignal);
      downloadToken = token;
      requestSignal.throwIfAborted();
      const response = await raceWithAbort(this.fetchImpl(
        `https://api.telegram.org/file/bot${token}/${path}`,
        { signal: requestSignal, redirect: 'error' },
      ), requestSignal);
      if (!response.ok) throw new TelegramApiError(operation, `HTTP ${response.status}`);
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null) checkSize(Number(contentLength));
      if (response.body === null) throw new TelegramApiError(operation, 'missing voice body');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        requestSignal.throwIfAborted();
        const chunk = await raceWithAbort(reader.read(), requestSignal);
        if (chunk.done) break;
        length += chunk.value.byteLength;
        checkSize(length);
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      if (requestSignal.aborted) throw new TelegramApiError(operation, 'request aborted or timed out');
      if (error instanceof TelegramApiError) {
        throw new TelegramApiError(operation, safeApiDescription(error.description, downloadToken, 0));
      }
      throw new TelegramApiError(operation, 'voice request failed');
    } finally {
      controller.abort();
      // Do not let an uncooperative stream delay cancellation or leak its error.
      if (reader !== undefined) void reader.cancel().catch(() => {});
    }
  }

  private async resolveToken(operation: string, signal: AbortSignal): Promise<string> {
    try {
      signal.throwIfAborted();
      return typeof this.options.token === 'string'
        ? this.options.token
        : await raceWithAbort(this.options.token(), signal);
    } catch {
      throw new TelegramApiError(operation, signal.aborted
        ? 'request aborted or timed out'
        : 'credential resolution failed');
    }
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
    const token = await this.resolveToken(operation, requestSignal);

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.telegram.org/bot${token}/${operation}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: requestSignal,
          redirect: 'error',
        },
      );
    } catch {
      throw new TelegramApiError(operation, requestSignal.aborted
        ? 'request aborted or timed out'
        : 'network request failed');
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
        safeApiDescription(payload?.description, token, response.status),
        {
          ...(typeof payload?.error_code === 'number' && Number.isSafeInteger(payload.error_code)
            ? { errorCode: payload.error_code }
            : {}),
          ...(typeof payload?.parameters?.retry_after === 'number'
            && Number.isFinite(payload.parameters.retry_after)
            && payload.parameters.retry_after >= 0
            ? { retryAfter: payload.parameters.retry_after }
            : {}),
        },
      );
    }
    if (payload.result === undefined) {
      throw new TelegramApiError(operation, 'unknown API error');
    }
    return payload.result;
  }
}
