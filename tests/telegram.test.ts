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

  it('stops promptly while an async token resolution is pending', async () => {
    const controller = new AbortController();
    let resolveToken: ((token: string) => void) | undefined;
    const token = vi.fn(() => new Promise<string>((resolve) => {
      resolveToken = resolve;
    }));
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const adapter = new TelegramAdapter({
      token,
      pollTimeoutSeconds: 30,
      requestTimeoutMs: 15_000,
      fetch: fetchMock,
    });

    const running = adapter.start(async () => {}, controller.signal);
    await Promise.resolve();
    controller.abort(new Error('test shutdown'));
    await running;
    resolveToken?.('late-token');

    expect(token).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('confirms an update before handing it to the bridge', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 77,
          message: {
            message_id: 10,
            chat: { id: 42, type: 'private' },
            from: { id: 42 },
            text: 'hello',
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: [],
      }), { status: 200 }));
    const adapter = new TelegramAdapter({
      token: 'test-token',
      pollTimeoutSeconds: 30,
      requestTimeoutMs: 15_000,
      fetch: fetchMock,
    });
    const handled = vi.fn(async () => {
      controller.abort();
    });

    await adapter.start(handled, controller.signal);

    expect(handled).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const confirmation = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    ) as { offset: number; timeout: number };
    expect(confirmation).toMatchObject({ offset: 78, timeout: 0 });
  });
});
