import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/bridge.js';
import { splitTelegramText } from '../src/telegram.js';

describe('parseCommand', () => {
  it('parses commands without trusting Telegram bot suffixes', () => {
    expect(parseCommand(' /Use@my_bot  session-42 ')).toEqual({
      name: 'use@my_bot',
      argument: 'session-42',
    });
  });

  it('ignores ordinary chat messages', () => {
    expect(parseCommand('please run the tests')).toBeUndefined();
  });
});

describe('splitTelegramText', () => {
  it('keeps short messages intact', () => {
    expect(splitTelegramText('hello', 10)).toEqual(['hello']);
  });

  it('splits long messages on friendly boundaries', () => {
    expect(splitTelegramText('alpha beta gamma', 10)).toEqual([
      'alpha beta',
      'gamma',
    ]);
  });

  it('rejects invalid limits', () => {
    expect(() => splitTelegramText('hello', 0)).toThrow(TypeError);
  });
});
