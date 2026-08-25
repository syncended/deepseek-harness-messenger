import type { Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import { MessengerBridge } from './bridge.js';
import { TelegramAdapter } from './telegram.js';

export { MessengerBridge, parseCommand } from './bridge.js';
export { TelegramAdapter, TelegramApiError, splitTelegramText } from './telegram.js';
export type {
  InboundMessengerMessage,
  MessengerAdapter,
  ParsedCommand,
} from './types.js';

export const name = 'messenger';
export const inject = ['agents', 'credentials'];

export interface Config {
  telegram: {
    enabled: boolean;
    tokenRef: string;
    allowedChatIds: string[];
    allowedUserIds: string[];
    privateChatsOnly: boolean;
    pollTimeoutSeconds: number;
    requestTimeoutMs: number;
  };
}

export const Config: z<Config> = z.object({
  telegram: z.object({
    enabled: z.boolean().default(true),
    tokenRef: z.string().default('TELEGRAM_BOT_TOKEN'),
    allowedChatIds: z.array(z.string()).default([]),
    allowedUserIds: z.array(z.string()).default([]),
    privateChatsOnly: z.boolean().default(true),
    pollTimeoutSeconds: z.number().min(1).max(50).default(30),
    requestTimeoutMs: z.number().min(1_000).max(120_000).default(15_000),
  }),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.telegram.enabled) {
    ctx.logger.info('messenger: Telegram adapter is disabled');
    return;
  }
  if (config.telegram.allowedChatIds.length === 0) {
    ctx.logger.warn(
      'messenger: allowedChatIds is empty; all Telegram messages will be ignored',
    );
  }

  const controller = new AbortController();
  const outbound = new Set<Promise<void>>();
  let acceptingOutbound = true;
  let polling: Promise<void> = Promise.resolve();

  ctx.effect(
    () => async () => {
      acceptingOutbound = false;
      controller.abort(new Error('messenger plugin disposed'));
      await Promise.allSettled([polling, ...outbound]);
    },
    'messenger.telegram',
  );

  const tokenRef = credentialRef(config.telegram.tokenRef);
  const adapter = new TelegramAdapter({
    token: async () => {
      const resolved = await ctx.credentials.resolve(tokenRef);
      if (resolved === undefined) {
        throw new Error(
          `messenger: credential ${config.telegram.tokenRef} is not configured in DSH`,
        );
      }
      return resolved.value;
    },
    pollTimeoutSeconds: config.telegram.pollTimeoutSeconds,
    requestTimeoutMs: config.telegram.requestTimeoutMs,
    signal: controller.signal,
  });
  await adapter.validate(controller.signal);

  const bridge = new MessengerBridge(ctx, {
    allowedChatIds: config.telegram.allowedChatIds,
    allowedUserIds: config.telegram.allowedUserIds,
    privateChatsOnly: config.telegram.privateChatsOnly,
  });
  bridge.registerAdapter(adapter);

  ctx.on('session/event', (session, event) => {
    if (!acceptingOutbound) return;
    const task = bridge.onSessionEvent(String(session.id), event);
    outbound.add(task);
    void task
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          ctx.logger.warn('messenger: failed to mirror assistant message: %o', error);
        }
      })
      .finally(() => outbound.delete(task));
  });

  polling = adapter
    .start((message) => bridge.handle(message), controller.signal)
    .catch((error: unknown) => {
      if (!controller.signal.aborted) {
        ctx.logger.error('messenger: Telegram polling stopped: %o', error);
      }
    });

  ctx.logger.info(
    'messenger: Telegram adapter connected using credential %s',
    config.telegram.tokenRef,
  );
}
