import type {
  InboundMessengerMessage,
  MessengerAdapter,
} from './types.js';

const TELEGRAM_TEXT_LIMIT = 4_096;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

interface TelegramUser {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
}

interface TelegramMessage {
  readonly message_id: number;
  readonly text?: string;
  readonly chat: {
    readonly id: number;
    readonly type: 'private' | 'group' | 'supergroup' | 'channel';
  };
  readonly from?: TelegramUser;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

interface TelegramResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
}

export interface TelegramAdapterOptions {
  readonly token: string | (() => Promise<string>);
  readonly pollTimeoutSeconds: number;
  readonly requestTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
}

export class TelegramApiError extends Error {
  constructor(operation: string, description: string) {
    super(`Telegram ${operation} failed: ${description}`);
    this.name = 'TelegramApiError';
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

function senderName(user: TelegramUser | undefined): string | undefined {
  if (user === undefined) return undefined;
  if (user.username) return `@${user.username}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return name || undefined;
}

export class TelegramAdapter implements MessengerAdapter {
  readonly id = 'telegram';
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: TelegramAdapterOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async validate(signal?: AbortSignal): Promise<void> {
    await this.call<unknown>('getMe', {}, signal);
  }

  async start(
    onMessage: (message: InboundMessengerMessage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let offset: number | undefined;
    let retryDelay = DEFAULT_RETRY_DELAY_MS;

    while (!signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>(
          'getUpdates',
          {
            ...(offset === undefined ? {} : { offset }),
            timeout: this.options.pollTimeoutSeconds,
            allowed_updates: ['message'],
          },
          signal,
        );
        retryDelay = DEFAULT_RETRY_DELAY_MS;

        for (const update of updates) {
          const message = update.message;
          if (message?.text !== undefined) {
            const name = senderName(message.from);
            await onMessage({
              transport: this.id,
              messageId: String(message.message_id),
              chatId: String(message.chat.id),
              chatKind: message.chat.type,
              senderId: String(message.from?.id ?? message.chat.id),
              ...(name === undefined ? {} : { senderName: name }),
              text: message.text,
            });
          }
          offset = update.update_id + 1;
        }
      } catch {
        if (signal.aborted) return;
        await abortableDelay(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    for (const chunk of splitTelegramText(text)) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: chunk,
      });
    }
  }

  private async call<T>(
    operation: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = typeof this.options.token === 'string'
      ? this.options.token
      : await this.options.token();
    const timeoutMs = operation === 'getUpdates'
      ? this.options.pollTimeoutSeconds * 1_000 + this.options.requestTimeoutMs
      : this.options.requestTimeoutMs;
    const signals = [
      this.options.signal,
      signal,
      AbortSignal.timeout(timeoutMs),
    ].filter((candidate): candidate is AbortSignal => candidate !== undefined);
    const requestSignal = AbortSignal.any(signals);

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
      if (requestSignal?.aborted) throw error;
      throw new TelegramApiError(operation, 'network request failed');
    }
    if (!response.ok) {
      throw new TelegramApiError(operation, `HTTP ${response.status}`);
    }

    const payload = (await response.json()) as TelegramResponse<T>;
    if (!payload.ok || payload.result === undefined) {
      throw new TelegramApiError(
        operation,
        payload.description ?? 'unknown API error',
      );
    }
    return payload.result;
  }
}
