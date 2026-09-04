import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  TELEGRAM_BOT_TOKEN_REF,
  apply,
  inject,
  validateMessengerConfig,
  type Config,
} from '../src/index.js';

function config(overrides: Partial<Config['telegram']> = {}): Config {
  return {
    telegram: {
      enabled: false,
      tokenRef: TELEGRAM_BOT_TOKEN_REF,
      allowedChatIds: [],
      allowedUserIds: [],
      privateChatsOnly: true,
      pollTimeoutSeconds: 30,
      requestTimeoutMs: 15_000,
      ...overrides,
    },
  };
}

describe('Messenger Host settings validation', () => {
  it('opens the public durable domain even when Telegram is disabled and closes it on disposal', async () => {
    const initial = config();
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({
      global: { get: () => ({ subscriptions: [], links: [] }), set: vi.fn(async () => {}) },
      close,
    }));
    const disposers: Array<() => Promise<void>> = [];
    const register = vi.fn(() => () => {});
    const ctx = {
      storageDomain: { open },
      tools: { register },
      settings: { register: () => ({ get: () => initial, watch: () => {} }) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: () => () => {},
      effect: (setup: () => () => Promise<void>) => { disposers.push(setup()); },
    } as unknown as Context;
    expect(inject).toContain('storageDomain');
    await apply(ctx, initial);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ name: 'messenger_notifications' }));
    expect(register).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await Promise.all(disposers.map((dispose) => dispose()));
    expect(close).toHaveBeenCalledOnce();
  });

  it('accepts the secure disabled defaults', () => {
    expect(() => validateMessengerConfig(config())).not.toThrow();
  });

  it('reserves the Telegram credential reference', () => {
    expect(() => validateMessengerConfig(config({
      tokenRef: 'OTHER_PROVIDER_SECRET',
    }))).toThrow(TELEGRAM_BOT_TOKEN_REF);
  });

  it('requires chat and group operator allowlists when enabled', () => {
    expect(() => validateMessengerConfig(config({ enabled: true }))).toThrow(
      'allowed chat ID',
    );
    expect(() => validateMessengerConfig(config({
      enabled: true,
      allowedChatIds: ['-100123'],
      privateChatsOnly: false,
    }))).toThrow('allowed user ID');
  });
});
