import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ClientDefinition {
  id: string;
  factory: (require: (id: string) => unknown) => {
    __testing: {
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

function loadClientTesting() {
  let definition: ClientDefinition | undefined;
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const execute = new Function('window', source);
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
  }).__testing;
}

describe('Messenger Web settings helpers', () => {
  const testing = loadClientTesting();

  it('normalizes and deduplicates ID lists', () => {
    expect(testing.splitIds('123, 456\n123')).toEqual(['123', '456']);
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
