import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

interface ClientDefinition {
  id: string;
  factory: (require: (id: string) => unknown) => {
    apply(ctx: any): void;
    inject: string[];
    __testing: {
      createSettingsApi(remote: any): any;
      splitIds(value: string): string[];
      telegramValue(section: unknown): Record<string, unknown>;
      messengerNamespace(describe: unknown): unknown;
      isLocalhostProxy(hostname: unknown): boolean;
      createDirectSettingsScope(api: any): {
        getSnapshot(): Record<string, any>;
        subscribe(listener: () => void): () => void;
        reload(): Promise<void>;
        set(field: string, value: unknown): Promise<void>;
        dispose(): Promise<void>;
      };
      sameTelegram(
        left: Record<string, any>,
        right: Record<string, any>,
      ): boolean;
      validateForm(
        form: Record<string, unknown>,
        credential: { configured?: boolean } | undefined,
        tokenDraft: string,
      ): Record<string, unknown>;
    };
  };
}

function loadClient() {
  let definition: ClientDefinition | undefined;
  const execute = new Function('window', CLIENT_SOURCE);
  execute({
    __ModuleLoader__: {
      load(value: ClientDefinition) {
        definition = value;
      },
    },
  });
  if (definition === undefined) throw new Error('client bundle did not register');
  const reactStub = {
    createElement() {},
    useCallback() {},
    useEffect() {},
    useMemo() {},
    useState() {},
    useSyncExternalStore() {},
  };
  return definition.factory((id) => {
    if (id === 'react') return reactStub;
    throw new Error(`unexpected client import: ${id}`);
  });
}

function loadClientTesting() {
  return loadClient().__testing;
}

describe('Messenger Web settings helpers', () => {
  const testing = loadClientTesting();

  it('uses controller remotes without the removed connection.api property', async () => {
    const client = loadClient();
    const describe = vi.fn(async () => ({ ok: true, value: { namespaces: [] } }));
    let injected: any;
    const bind = vi.fn(() => ({}));
    client.apply({
      remote: { settings: { describe }, credentials: {} },
      // No connection service or get() method: modern transport has no .api.
      settingsScope: { bind, describe: () => ({}) },
      effect: () => {},
      slots: {
        inject: (_slot: string, register: () => void) => register(),
        register: (section: any) => { injected = section.inject(); },
      },
    });
    expect(client.inject).toContain('remote.settings');
    expect(client.inject).toContain('remote.credentials');
    expect(client.inject).not.toContain('connection');
    expect(bind).toHaveBeenCalledWith({ namespace: 'messenger' });
    await expect(injected.api.settings.describe({})).resolves.toEqual({
      result: { ok: true, value: { namespaces: [] } },
    });
    expect(describe).toHaveBeenCalledWith();
  });

  it('adapts positional remote calls and Telegram credential metadata', async () => {
    const metadata = { TELEGRAM_BOT_TOKEN: { configured: true, writable: true } };
    const remote = {
      settings: {
        describe: vi.fn(async () => ({ ok: true, value: { namespaces: [] } })),
        mutate: vi.fn(async () => ({ ok: true, value: { revision: 7 } })),
      },
      credentials: {
        describe: vi.fn(async () => ({ ok: true, value: metadata })),
        set: vi.fn(async () => ({ ok: true, value: undefined })),
        unset: vi.fn(async () => ({ ok: true, value: undefined })),
      },
    };
    const api = testing.createSettingsApi(remote);
    const ops = [{ op: 'set', path: ['telegram'], value: { enabled: false } }];
    await expect(api.settings.mutate({ ns: 'messenger', ops, expectedRevision: 6 })).resolves.toEqual({
      result: { ok: true, value: { revision: 7 } },
    });
    expect(remote.settings.mutate).toHaveBeenCalledWith('messenger', ops, 6);
    const refs = Object.keys(metadata);
    expect(await api.credentials.describe({ refs })).toEqual({
      result: { ok: true, value: { credentials: metadata } },
    });
    expect(remote.credentials.describe).toHaveBeenCalledWith(refs);
    await expect(api.credentials.set({ ref: refs[0], value: 'test-value' })).resolves.toEqual({
      result: { ok: true, value: undefined },
    });
    expect(remote.credentials.set).toHaveBeenCalledWith(refs[0], 'test-value');
    await expect(api.credentials.unset({ ref: refs[0] })).resolves.toEqual({
      result: { ok: true, value: undefined },
    });
    expect(remote.credentials.unset).toHaveBeenCalledWith(refs[0]);
    const denied = { ok: false, error: { message: 'Not authorized' } };
    remote.credentials.describe.mockResolvedValueOnce(denied as any);
    expect(await api.credentials.describe({ refs })).toEqual({ result: denied });
    remote.settings.describe.mockResolvedValueOnce(denied as any);
    const scope = testing.createDirectSettingsScope(api);
    await expect(scope.reload()).rejects.toThrow('Not authorized');
    await scope.dispose();
  });

  it('normalizes and deduplicates ID lists', () => {
    expect(testing.splitIds('123, 456\n123')).toEqual(['123', '456']);
  });

  it('uses DSH theme tokens instead of fixed light-theme colors', () => {
    expect(CLIENT_SOURCE).toContain('var(--dsw-alias-bg-layer-3)');
    expect(CLIENT_SOURCE).toContain('var(--dsw-alias-label-primary)');
    expect(CLIENT_SOURCE).toContain('var(--dsw-alias-border-l2)');
    expect(CLIENT_SOURCE).not.toContain('--dsw-alias-bg-primary');
    expect(CLIENT_SOURCE).not.toContain('--dsw-alias-text-primary');
    expect(CLIENT_SOURCE).not.toContain('--dsw-alias-border-default');
    expect(CLIENT_SOURCE).not.toContain('--dsw-alias-fill-l2');
    expect(CLIENT_SOURCE).not.toContain('--dsw-font-mono');
    expect(CLIENT_SOURCE).toContain('--ds-font-family-code');
  });

  it('finds the Messenger namespace in a fresh Host description', () => {
    const messenger = { ns: 'messenger', revision: 2 };
    expect(testing.messengerNamespace({
      namespaces: [{ ns: 'shell' }, messenger],
    })).toBe(messenger);
    expect(testing.messengerNamespace({ namespaces: [] })).toBeUndefined();
  });

  it('recognizes only reserved localhost subdomains as local proxies', () => {
    expect(testing.isLocalhostProxy('dsh.localhost')).toBe(true);
    expect(testing.isLocalhostProxy('DSHR.LOCALHOST')).toBe(true);
    expect(testing.isLocalhostProxy('localhost')).toBe(false);
    expect(testing.isLocalhostProxy('dsh.localhost.example.com')).toBe(false);
  });

  it('reads and revision-fences settings through a localhost proxy', async () => {
    const telegram = testing.telegramValue(undefined);
    let mutation: any;
    const namespace = (revision: number, enabled = false) => ({
      ns: 'messenger',
      schema: {},
      value: { telegram: { ...telegram, enabled } },
      base: { telegram },
      applies: 'live',
      secrets: [],
      revision,
    });
    const api = {
      settings: {
        async describe() {
          return { result: { ok: true, value: {
            writable: true,
            hasDocument: true,
            namespaces: [namespace(4)],
          } } };
        },
        async mutate(request: unknown) {
          mutation = request;
          return { result: { ok: true, value: namespace(5, true) } };
        },
      },
    };
    const scope = testing.createDirectSettingsScope(api);
    await scope.reload();
    expect(scope.getSnapshot()).toMatchObject({
      status: 'ready',
      revision: 4,
      writable: true,
      mode: 'host',
    });
    await scope.set('telegram', { ...telegram, enabled: true });
    expect(mutation).toMatchObject({
      ns: 'messenger',
      expectedRevision: 4,
      ops: [{ op: 'set', path: ['telegram'] }],
    });
    expect(scope.getSnapshot()).toMatchObject({
      status: 'ready',
      revision: 5,
      value: { telegram: { enabled: true } },
    });
    await scope.dispose();
  });

  it('serializes proxy reloads and writes so revisions cannot regress', async () => {
    const telegram = testing.telegramValue(undefined);
    let resolveDescribe!: (value: unknown) => void;
    let mutateCalled = false;
    const api = {
      settings: {
        describe() {
          return new Promise((resolve) => {
            resolveDescribe = resolve;
          });
        },
        async mutate() {
          mutateCalled = true;
          return { result: { ok: true, value: {
            ns: 'messenger', schema: {}, value: { telegram: { ...telegram, enabled: true } },
            applies: 'live', secrets: [], revision: 5,
          } } };
        },
      },
    };
    const scope = testing.createDirectSettingsScope(api);
    const reload = scope.reload();
    const write = scope.set('telegram', { ...telegram, enabled: true });
    await Promise.resolve();
    expect(mutateCalled).toBe(false);
    resolveDescribe({ result: { ok: true, value: {
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: 'messenger', schema: {}, value: { telegram },
        applies: 'live', secrets: [], revision: 4,
      }],
    } } });
    await reload;
    await write;
    expect(scope.getSnapshot()).toMatchObject({ revision: 5 });
    await scope.dispose();
  });

  it('refreshes a proxy scope after a rejected stale write', async () => {
    const telegram = testing.telegramValue(undefined);
    let reads = 0;
    const api = {
      settings: {
        async describe() {
          reads += 1;
          return { result: { ok: true, value: {
            writable: true,
            hasDocument: true,
            namespaces: [{
              ns: 'messenger', schema: {}, value: { telegram },
              applies: 'live', secrets: [], revision: reads === 1 ? 4 : 6,
            }],
          } } };
        },
        async mutate() {
          return { result: { ok: false, error: { message: 'settings revision conflict' } } };
        },
      },
    };
    const scope = testing.createDirectSettingsScope(api);
    await scope.reload();
    await expect(scope.set('telegram', telegram)).rejects.toThrow('settings revision conflict');
    expect(scope.getSnapshot()).toMatchObject({ status: 'ready', revision: 6 });
    await scope.dispose();
  });

  it('waits for an in-flight proxy write during disposal', async () => {
    const telegram = testing.telegramValue(undefined);
    let resolveMutation!: (value: unknown) => void;
    const api = {
      settings: {
        async describe() {
          return { result: { ok: true, value: {
            writable: true,
            hasDocument: true,
            namespaces: [{
              ns: 'messenger', schema: {}, value: { telegram },
              applies: 'live', secrets: [], revision: 1,
            }],
          } } };
        },
        mutate() {
          return new Promise((resolve) => {
            resolveMutation = resolve;
          });
        },
      },
    };
    const scope = testing.createDirectSettingsScope(api);
    await scope.reload();
    const write = scope.set('telegram', telegram);
    await Promise.resolve();
    let disposed = false;
    const disposal = scope.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    resolveMutation({ result: { ok: true, value: {
      ns: 'messenger', schema: {}, value: { telegram },
      applies: 'live', secrets: [], revision: 2,
    } } });
    await write;
    await disposal;
    expect(disposed).toBe(true);
  });

  it('uses secure Telegram defaults', () => {
    expect(testing.telegramValue(undefined)).toMatchObject({
      enabled: false,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      privateChatsOnly: true,
      allowedChatIds: [],
      allowedUserIds: [],
    });
  });

  it('detects a Host write that did not land', () => {
    const intended = testing.telegramValue({ telegram: {
      enabled: true,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      allowedChatIds: ['123'],
      allowedUserIds: [],
      privateChatsOnly: true,
      pollTimeoutSeconds: 30,
      requestTimeoutMs: 15000,
    } });
    const retained = testing.telegramValue(undefined);
    expect(testing.sameTelegram(retained, intended)).toBe(false);
    expect(testing.sameTelegram(intended, intended)).toBe(true);
  });

  it('validates an enabled private-chat configuration', () => {
    expect(testing.validateForm({
      enabled: true,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      allowedChatIds: '123456789',
      allowedUserIds: '',
      privateChatsOnly: true,
      pollTimeoutSeconds: '30',
      requestTimeoutMs: '15000',
    }, { configured: true }, '')).toMatchObject({
      enabled: true,
      allowedChatIds: ['123456789'],
      privateChatsOnly: true,
    });
  });

  it('rejects non-Telegram credential references and malformed token drafts', () => {
    const base = {
      enabled: false,
      tokenRef: 'OTHER_PROVIDER_SECRET',
      allowedChatIds: '',
      allowedUserIds: '',
      privateChatsOnly: true,
      pollTimeoutSeconds: '30',
      requestTimeoutMs: '15000',
    };
    expect(() => testing.validateForm(base, undefined, '')).toThrow(
      'TELEGRAM_BOT_TOKEN',
    );
    expect(() => testing.validateForm({
      ...base,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
    }, undefined, 'not-a-telegram-token')).toThrow('Telegram bot token format');
  });

  it('requires an operator allowlist for group access', () => {
    expect(() => testing.validateForm({
      enabled: true,
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      allowedChatIds: '-100123456789',
      allowedUserIds: '',
      privateChatsOnly: false,
      pollTimeoutSeconds: '30',
      requestTimeoutMs: '15000',
    }, { configured: true }, '')).toThrow('Group access requires');
  });
});
