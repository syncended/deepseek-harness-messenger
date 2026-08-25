import { describe, expect, it, vi } from 'vitest';
import { TelegramAdapter } from '../src/telegram.js';

describe('TelegramAdapter credentials', () => {
  it('re-resolves a token for every API operation', async () => {
    const tokens = ['first-token', 'second-token'];
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(
      JSON.stringify({ ok: true, result: {} }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ));
    const adapter = new TelegramAdapter({
      token: async () => tokens.shift() ?? 'unexpected-token',
      pollTimeoutSeconds: 30,
      requestTimeoutMs: 15_000,
      fetch: fetchMock as typeof globalThis.fetch,
    });

    await adapter.validate();
    await adapter.sendText('42', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('first-token/getMe');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      'second-token/sendMessage',
    );
  });
});
