import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ClientDefinition {
  id: string;
  factory: (require: (id: string) => unknown) => {
    __testing: {
      splitIds(value: string): string[];
      telegramValue(section: unknown): Record<string, unknown>;
      messengerNamespace(describe: unknown): unknown;
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
