import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_BOT_TOKEN_REF,
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
