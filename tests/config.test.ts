import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { MessengerBridge } from '../src/bridge.js';
import { TelegramAdapter } from '../src/telegram.js';
import { messengerBindingKey, type MessengerBindingRecord } from '../src/store.js';
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
    const closeBindings = vi.fn(async () => {});
    const open = vi.fn(async (spec: { name: string }) => spec.name === 'messenger_bindings'
      ? { table: () => ({ entries: () => [][Symbol.iterator]() }), close: closeBindings }
      : {
        global: { get: () => ({ subscriptions: [], links: [] }), set: vi.fn(async () => {}) },
        close,
      });
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
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ name: 'messenger_bindings' }));
    expect(register).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await Promise.all(disposers.map((dispose) => dispose()));
    expect(close).toHaveBeenCalledOnce();
    expect(closeBindings).toHaveBeenCalledOnce();
  });

  it('restores after the old runtime drains, sharing both stores across reconfiguration', async () => {
    const initial = config({ enabled: true, allowedChatIds: ['100'] });
    const rows = new Map<string, MessengerBindingRecord>();
    const closeBindings = vi.fn(async () => {});
    const closeNotifications = vi.fn(async () => {});
    const open = vi.fn(async (spec: { name: string }) => spec.name === 'messenger_bindings'
      ? { table: () => ({ entries: () => rows.entries() }), close: closeBindings }
      : {
        global: { get: () => ({ subscriptions: [], links: [] }), set: vi.fn(async () => {}) },
        close: closeNotifications,
      });
    const disposers: Array<() => Promise<void>> = [];
    const listeners = new Map<string, (...args: any[]) => unknown>();
    const ctx = {
      storageDomain: { open },
      tools: { register: () => () => {} },
      sessionController: { list: async () => ({ items: [{ sessionId: 'session-1' }] }) },
      settings: { register: () => ({ get: () => initial, watch: () => {} }) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: (event: string, listener: (...args: any[]) => unknown) => {
        listeners.set(event, listener);
        return () => true;
      },
      effect: (setup: () => () => Promise<void>) => { disposers.push(setup()); },
    } as unknown as Context;
    const snapshots: number[] = [];
    const restore = MessengerBridge.prototype.restoreBindings;
    const dispose = MessengerBridge.prototype.dispose;
    vi.spyOn(TelegramAdapter.prototype, 'validate').mockResolvedValue(undefined);
    vi.spyOn(TelegramAdapter.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(MessengerBridge.prototype, 'restoreBindings').mockImplementation(async function (this: MessengerBridge) {
      await restore.call(this);
      snapshots.push(rows.size);
    });
    let drained = false;
    vi.spyOn(MessengerBridge.prototype, 'dispose').mockImplementation(async function (this: MessengerBridge) {
      await dispose.call(this);
      if (drained) return;
      drained = true;
      // Simulate the final accepted binding write completing during shutdown.
      rows.set(messengerBindingKey('telegram', '100', '100'), {
        transport: 'telegram', chatId: '100', chatKind: 'private', senderId: '100',
        sessionId: 'session-1', updatedAt: new Date().toISOString(),
      });
    });
    try {
      await apply(ctx, initial);
      listeners.get('credentials/reference-updated')?.(TELEGRAM_BOT_TOKEN_REF);
      await vi.waitFor(() => expect(snapshots).toEqual([0, 1]));
      expect(open).toHaveBeenCalledTimes(2);
      expect(closeBindings).not.toHaveBeenCalled();
      expect(closeNotifications).not.toHaveBeenCalled();
    } finally {
      try {
        await Promise.all(disposers.map((fn) => fn()));
        expect(closeBindings).toHaveBeenCalledOnce();
        expect(closeNotifications).toHaveBeenCalledOnce();
      } finally {
        vi.restoreAllMocks();
      }
    }
  });

  it('closes the binding domain if notification storage cannot initialize', async () => {
    const close = vi.fn(async () => {});
    const ctx = {
      storageDomain: { open: vi.fn(async (spec: { name: string }) => {
        if (spec.name === 'messenger_notifications') throw new Error('notification storage unavailable');
        return { table: () => ({}), close };
      }) },
      effect: () => {},
    } as unknown as Context;
    await expect(apply(ctx, config())).rejects.toThrow('notification storage unavailable');
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
