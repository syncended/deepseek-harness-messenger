import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-workspace';
import z from '@deepseek-ai/schemastery';
import { MessengerBridge } from './bridge.js';
import { TelegramAdapter } from './telegram.js';
import { installNotificationTool } from './notifications.js';
import { openNotificationStore, type NotificationStore } from './notification-store.js';

export { MessengerBridge, parseCommand } from './bridge.js';
export { TelegramAdapter, TelegramApiError, splitTelegramText } from './telegram.js';
export type {
  InboundMessengerMessage,
  MessengerAdapter,
  ParsedCommand,
} from './types.js';

export const name = 'messenger';
export const inject = [
  'agents',
  'sessionController',
  'workspaceRegistry',
  'credentials',
  'permissionPresets',
  'settings',
  'tools',
  'storageDomain',
];
export const MESSENGER_SETTINGS_NAMESPACE = 'messenger';

export const TELEGRAM_BOT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN';
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/;
const TELEGRAM_USER_ID_PATTERN = /^\d+$/;

export interface TelegramConfig {
  enabled: boolean;
  tokenRef: string;
  allowedChatIds: string[];
  allowedUserIds: string[];
  privateChatsOnly: boolean;
  pollTimeoutSeconds: number;
  requestTimeoutMs: number;
}

export interface Config {
  telegram: TelegramConfig;
}

export const Config: z<Config> = z.object({
  telegram: z.object({
    enabled: z.boolean().default(false),
    tokenRef: z.string().default(TELEGRAM_BOT_TOKEN_REF),
    allowedChatIds: z.array(
      z.string().pattern(TELEGRAM_CHAT_ID_PATTERN),
    ).default([]),
    allowedUserIds: z.array(
      z.string().pattern(TELEGRAM_USER_ID_PATTERN),
    ).default([]),
    privateChatsOnly: z.boolean().default(true),
    pollTimeoutSeconds: z.number().min(1).max(50).default(30),
    requestTimeoutMs: z.number().min(1_000).max(120_000).default(15_000),
  }),
});

interface TelegramRuntime {
  readonly bridge: MessengerBridge | undefined;
  stop(): Promise<void>;
}

export function installQuestionAnswerer(
  ctx: Context,
  bridge: MessengerBridge,
): () => boolean {
  return ctx.on('user-questions/request', async (request, next) => {
    if (request.agent === undefined) return next();
    const answer = await bridge.askQuestion(
      String(request.agent.id),
      request.questions,
      request.signal,
    );
    return answer ?? next();
  }, { prepend: true });
}

async function startTelegramRuntime(
  ctx: Context,
  config: TelegramConfig,
  controller: AbortController,
  beforeActivate: () => Promise<void>,
  notificationStore: NotificationStore,
): Promise<TelegramRuntime> {
  if (config.allowedChatIds.length === 0) {
    ctx.logger.warn(
      'messenger: allowedChatIds is empty; all Telegram messages will be ignored',
    );
  }

  const outbound = new Set<Promise<void>>();
  const sessionEventTails = new Map<string, Promise<void>>();
  let acceptingOutbound = true;
  let polling: Promise<void> = Promise.resolve();
  let disposeQuestionAnswerer: (() => boolean) | undefined;
  let disposeSessionEvents: (() => void) | undefined;
  let bridge: MessengerBridge | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    acceptingOutbound = false;
    disposeSessionEvents?.();
    disposeQuestionAnswerer?.();
    controller.abort(new Error('messenger Telegram runtime stopped'));
    const disposingBridge = bridge?.dispose();
    await Promise.allSettled([polling, ...outbound]);
    await disposingBridge;
  };

  const tokenRef = credentialRef(TELEGRAM_BOT_TOKEN_REF);
  const adapter = new TelegramAdapter({
    token: async () => {
      const resolved = await ctx.credentials.resolve(tokenRef);
      if (resolved === undefined) {
        throw new Error(
          `messenger: credential ${TELEGRAM_BOT_TOKEN_REF} is not configured in DSH`,
        );
      }
      if (!TELEGRAM_BOT_TOKEN_PATTERN.test(resolved.value)) {
        throw new Error('messenger: configured Telegram credential is not a bot token');
      }
      return resolved.value;
    },
    pollTimeoutSeconds: config.pollTimeoutSeconds,
    requestTimeoutMs: config.requestTimeoutMs,
    signal: controller.signal,
    onError: (error, retryDelayMs) => {
      if (retryDelayMs === 0) {
        ctx.logger.warn('messenger: Telegram update handler failed: %o', error);
      } else {
        ctx.logger.warn(
          'messenger: Telegram operation failed; retrying in %d ms: %o',
          retryDelayMs,
          error,
        );
      }
    },
  });

  try {
    await adapter.validate(controller.signal);
    await beforeActivate();
    if (controller.signal.aborted) throw controller.signal.reason;
  } catch (error) {
    await stop();
    throw error;
  }

  bridge = new MessengerBridge(ctx, {
    allowedChatIds: config.allowedChatIds,
    allowedUserIds: config.allowedUserIds,
    privateChatsOnly: config.privateChatsOnly,
    notificationStore,
  });
  bridge.registerAdapter(adapter);
  disposeQuestionAnswerer = installQuestionAnswerer(ctx, bridge);

  disposeSessionEvents = ctx.on('session/event', (session, event) => {
    if (!acceptingOutbound) return;
    const sessionId = String(session.id);
    const previous = sessionEventTails.get(sessionId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => bridge.onSessionEvent(sessionId, event));
    sessionEventTails.set(sessionId, task);
    outbound.add(task);
    void task
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          ctx.logger.warn('messenger: failed to mirror session event: %o', error);
        }
      })
      .finally(() => {
        outbound.delete(task);
        if (sessionEventTails.get(sessionId) === task) sessionEventTails.delete(sessionId);
      });
  });

  polling = adapter
    .start(async (message) => {
      try {
        await bridge.handle(message);
      } catch (error) {
        if (!controller.signal.aborted) {
          ctx.logger.warn('messenger: Telegram message handling failed: %o', error);
        }
      }
    }, controller.signal)
    .catch((error: unknown) => {
      if (!controller.signal.aborted) {
        ctx.logger.error('messenger: Telegram polling stopped: %o', error);
      }
    });

  ctx.logger.info(
    'messenger: Telegram adapter connected using credential %s',
    TELEGRAM_BOT_TOKEN_REF,
  );

  return {
    get bridge() { return stopped ? undefined : bridge; },
    stop,
  };
}

export function validateMessengerConfig(config: Config): void {
  const telegram = config.telegram;
  if (telegram.tokenRef !== TELEGRAM_BOT_TOKEN_REF) {
    throw new Error(`Telegram credential reference must be ${TELEGRAM_BOT_TOKEN_REF}`);
  }
  if (!Number.isInteger(telegram.pollTimeoutSeconds)) {
    throw new Error('Telegram long-poll timeout must be an integer');
  }
  if (!Number.isInteger(telegram.requestTimeoutMs)) {
    throw new Error('Telegram request timeout must be an integer');
  }
  if (telegram.enabled && telegram.allowedChatIds.length === 0) {
    throw new Error('Telegram requires at least one allowed chat ID when enabled');
  }
  if (
    telegram.enabled
    && !telegram.privateChatsOnly
    && telegram.allowedUserIds.length === 0
  ) {
    throw new Error('Telegram group access requires at least one allowed user ID');
  }
}

export async function apply(ctx: Context, entryConfig: Config): Promise<void> {
  let source = (): Config => entryConfig;
  let active: TelegramRuntime | undefined;
  let candidate: AbortController | undefined;
  let disposed = false;
  let generation = 0;
  let tail: Promise<void> = Promise.resolve();

  const notificationStore = await openNotificationStore(ctx);
  installNotificationTool(ctx, () => {
    const bridge = disposed ? undefined : active?.bridge;
    return bridge === undefined ? [] : [bridge];
  });

  const reconcile = (): Promise<void> => {
    const requestedGeneration = ++generation;
    candidate?.abort(new Error('messenger configuration superseded'));

    tail = tail.then(async () => {
      if (disposed || requestedGeneration !== generation) return;

      const current = source();
      try {
        validateMessengerConfig(current);
      } catch (error) {
        ctx.logger.error('messenger: configuration is invalid: %o', error);
        return;
      }
      if (!current.telegram.enabled) {
        await active?.stop();
        active = undefined;
        ctx.logger.info('messenger: Telegram adapter is disabled');
        return;
      }

      const previous = active;
      const controller = new AbortController();
      candidate = controller;
      try {
        const next = await startTelegramRuntime(
          ctx,
          current.telegram,
          controller,
          async () => {
            if (disposed || requestedGeneration !== generation) {
              controller.abort(new Error('messenger configuration superseded'));
              throw controller.signal.reason;
            }
            await previous?.stop();
            if (active === previous) active = undefined;
          },
          notificationStore,
        );
        if (disposed || requestedGeneration !== generation) {
          await next.stop();
          return;
        }
        active = next;
      } catch (error) {
        if (!controller.signal.aborted) {
          ctx.logger.error('messenger: Telegram adapter could not start: %o', error);
        }
      } finally {
        if (candidate === controller) candidate = undefined;
      }
    });
    return tail;
  };

  ctx.effect(
    () => async () => {
      disposed = true;
      generation += 1;
      candidate?.abort(new Error('messenger plugin disposed'));
      await tail;
      await active?.stop();
      active = undefined;
    },
    'messenger.runtime',
  );

  const settings = ctx.settings.register(
    MESSENGER_SETTINGS_NAMESPACE,
    Config,
    {
      base: entryConfig,
      validate: validateMessengerConfig,
    },
  );
  source = () => settings.get();
  settings.watch(() => reconcile());

  ctx.on('credentials/reference-updated', (ref) => {
    if (String(ref) === TELEGRAM_BOT_TOKEN_REF) void reconcile();
  });

  await reconcile();
}
