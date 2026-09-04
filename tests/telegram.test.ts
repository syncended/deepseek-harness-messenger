import { describe, expect, it, vi } from 'vitest';
import {
  renderTelegramMarkdown,
  splitTelegramHtml,
  TelegramAdapter,
  TelegramApiError,
} from '../src/telegram.js';

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function messageUpdate(
  updateId: number,
  messageId: number,
  chatId: number,
  text: string,
): object {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId },
      text,
    },
  };
}

function adapterWith(fetch: typeof globalThis.fetch, options: {
  readonly requestTimeoutMs?: number;
  readonly onError?: (error: unknown, retryDelayMs: number) => void;
} = {}): TelegramAdapter {
  return new TelegramAdapter({
    token: 'test-token',
    pollTimeoutSeconds: 30,
    requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
    fetch,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}

describe('renderTelegramMarkdown', () => {
  it('renders common model Markdown with Telegram HTML', () => {
    expect(renderTelegramMarkdown([
      '# Result',
      '',
      '**Bold**, *italic*, `inline` and [docs](https://example.com?a=1&b=2).',
      '- first item',
      '> quoted <text>',
    ].join('\n'))).toBe([
      '<b>Result</b>',
      '',
      '<b>Bold</b>, <i>italic</i>, <code>inline</code> and <a href="https://example.com?a=1&amp;b=2">docs</a>.',
      '• first item',
      '<blockquote>quoted &lt;text&gt;</blockquote>',
    ].join('\n'));
  });

  it('preserves fenced code literally and escapes raw HTML', () => {
    expect(renderTelegramMarkdown('```ts\nconst tag = "<b>";\n```\n<div>unsafe</div>')).toBe(
      '<pre><code class="language-ts">const tag = "&lt;b&gt;";</code></pre>\n&lt;div&gt;unsafe&lt;/div&gt;',
    );
    expect(renderTelegramMarkdown('Path C:\\work\\file')).toBe('Path C:\\work\\file');
    expect(renderTelegramMarkdown('[docs](https://example.com/a_(b))')).toBe(
      '<a href="https://example.com/a_(b)">docs</a>',
    );
  });
});

describe('splitTelegramHtml', () => {
  it('closes and reopens formatting across visible-text boundaries', () => {
    const html = renderTelegramMarkdown(`**${'x'.repeat(250)}**`);
    const chunks = splitTelegramHtml(html, 100);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.startsWith('<b>') && chunk.endsWith('</b>'))).toBe(true);
    expect(chunks.map((chunk) => chunk.replace(/<[^>]+>/g, '').length)).toEqual([100, 100, 50]);
  });

  it('keeps long fenced code blocks independently valid', () => {
    const html = renderTelegramMarkdown(`\`\`\`ts\n${'🙂'.repeat(120)}\n\`\`\``);
    const chunks = splitTelegramHtml(html, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => (
      chunk.startsWith('<pre><code class="language-ts">')
      && chunk.endsWith('</code></pre>')
    ))).toBe(true);
    expect(chunks.every((chunk) => (
      chunk.replace(/<[^>]+>/g, '').length <= 80
    ))).toBe(true);
  });
});

describe('TelegramAdapter text accounting', () => {
  it('counts formatted text after entities using UTF-16 units', () => {
    const adapter = adapterWith(vi.fn<typeof globalThis.fetch>());

    expect(adapter.textLength('**x** & <tag>')).toBe('x & <tag>'.length);
    expect(adapter.textLength('🙂')).toBe(2);
  });
});

describe('TelegramAdapter credentials', () => {
  it('re-resolves a token for every API operation', async () => {
    const tokens = ['first-token', 'second-token', 'third-token'];
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => (
      jsonResponse({ message_id: 9 })
    ));
    const adapter = new TelegramAdapter({
      token: async () => tokens.shift() ?? 'unexpected-token',
      pollTimeoutSeconds: 30,
      requestTimeoutMs: 15_000,
      fetch: fetchMock as typeof globalThis.fetch,
    });

    await adapter.validate();
    const sent = await adapter.sendText('42', 'hello');

    expect(sent).toEqual({ chatId: '42', messageId: '9' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('first-token/getMe');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      'second-token/setMyCommands',
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      'third-token/sendMessage',
    );
  });

  it('registers the control commands during validation', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(true));
    const adapter = adapterWith(fetchMock);

    await adapter.validate();

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/setMyCommands');
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      commands: Array<{ command: string; description: string }>;
    };
    expect(body.commands.map(({ command }) => command)).toEqual([
      'start',
      'menu',
      'sessions',
      'resume',
      'new',
      'status',
      'model',
      'reasoning',
      'permission',
      'context',
      'steer',
      'cancel',
      'unbind',
      'notifications',
      'help',
    ]);
    expect(body.commands.every(({ description }) => description.length > 0)).toBe(true);
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
});

describe('TelegramAdapter polling', () => {
  it('confirms one fetched batch before handing it to handlers', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([
        messageUpdate(77, 10, 42, 'hello'),
        messageUpdate(78, 11, 42, 'again'),
      ]))
      .mockResolvedValueOnce(jsonResponse([]));
    const adapter = adapterWith(fetchMock);
    const handled = vi.fn(async () => {
      controller.abort();
    });

    await adapter.start(handled, controller.signal);

    expect(handled).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const confirmation = JSON.parse(
      String(fetchMock.mock.calls[3]?.[1]?.body),
    ) as { offset: number; timeout: number };
    expect(confirmation).toMatchObject({ offset: 79, timeout: 0 });
  });

  it('retains updates returned by confirmation and dispatches each once', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([
        messageUpdate(1, 101, 7, 'first'),
      ]))
      .mockResolvedValueOnce(jsonResponse([
        messageUpdate(2, 102, 7, 'retained'),
      ]))
      .mockImplementationOnce(async () => {
        controller.abort();
        return jsonResponse([]);
      });
    const adapter = adapterWith(fetchMock);
    const handled: string[] = [];

    await adapter.start(async (message) => {
      handled.push(message.text);
    }, controller.signal);

    expect(handled).toEqual(['first', 'retained']);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const confirmations = fetchMock.mock.calls.slice(3).map((call) => (
      JSON.parse(String(call[1]?.body)) as { offset: number; timeout: number }
    ));
    expect(confirmations).toEqual([
      expect.objectContaining({ offset: 2, timeout: 0 }),
      expect.objectContaining({ offset: 3, timeout: 0 }),
    ]);
  });

  it('keeps polling while a handler blocks and preserves per-chat order', async () => {
    const controller = new AbortController();
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([
        messageUpdate(1, 101, 7, 'first'),
      ]))
      .mockResolvedValueOnce(jsonResponse([
        messageUpdate(2, 102, 7, 'second'),
      ]))
      .mockImplementationOnce(async () => {
        controller.abort();
        return jsonResponse([]);
      });
    const adapter = adapterWith(fetchMock);
    const events: string[] = [];

    const running = adapter.start(async (message) => {
      events.push(`start:${message.text}`);
      if (message.text === 'first') await firstBlocked;
      events.push(`end:${message.text}`);
    }, controller.signal);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(events).toEqual(['start:first']);
    releaseFirst?.();
    await running;

    expect(events).toEqual([
      'start:first',
      'end:first',
      'start:second',
      'end:second',
    ]);
  });

  it('bounds confirmed handler backlog before acknowledging another batch', async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let poll = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { timeout?: number };
      if (fetchMock.mock.calls.length <= 2) return jsonResponse(true);
      if (body.timeout === 0) return jsonResponse([]);
      poll += 1;
      const start = (poll - 1) * 32 + 1;
      return jsonResponse(Array.from({ length: 32 }, (_, index) => (
        messageUpdate(start + index, start + index, start + index, `item-${start + index}`)
      )));
    });
    const adapter = adapterWith(fetchMock);
    const running = adapter.start(async () => blocked, controller.signal);

    // getMe + setMyCommands + three polls + only two confirmations. The
    // third batch remains unacknowledged while 64 handlers are pending.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(7);

    controller.abort();
    release?.();
    await running;
  });

  it('normalizes only group commands addressed to this bot', async () => {
    const controller = new AbortController();
    let servedUpdates = false;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const operation = String(input).split('/').pop();
      const body = JSON.parse(String(init?.body)) as { timeout?: number };
      if (operation === 'getMe') {
        return jsonResponse({ id: 1, username: 'our_bot' });
      }
      if (operation === 'setMyCommands') return jsonResponse(true);
      if (body.timeout === 30 && !servedUpdates) {
        servedUpdates = true;
        return jsonResponse([
          {
            update_id: 1,
            message: {
              message_id: 10,
              chat: { id: -7, type: 'supergroup' },
              from: { id: 9 },
              text: '/menu@our_bot',
            },
          },
          {
            update_id: 2,
            message: {
              message_id: 11,
              chat: { id: -7, type: 'supergroup' },
              from: { id: 9 },
              text: '/menu@other_bot',
            },
          },
        ]);
      }
      return jsonResponse([]);
    });
    const adapter = adapterWith(fetchMock);
    const texts: string[] = [];

    await adapter.start(async (message) => {
      texts.push(message.text);
      controller.abort();
    }, controller.signal);

    expect(texts).toEqual(['/menu', '/menu@other_bot']);
  });

  it('does not add long-poll padding to confirmation timeouts', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse([
        messageUpdate(1, 101, 7, 'first'),
      ]))
      .mockResolvedValueOnce(jsonResponse([]));
    const adapter = adapterWith(fetchMock, { requestTimeoutMs: 20 });

    await adapter.start(async () => {
      controller.abort();
    }, controller.signal);

    expect(timeoutSpy.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      20,
      20,
      30_020,
      20,
    ]);
    timeoutSpy.mockRestore();
  });

  it('reports polling errors with the retry delay', async () => {
    const controller = new AbortController();
    const onError = vi.fn((_error: unknown, _delay: number) => {
      controller.abort();
    });
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockRejectedValue(new Error('network down'));
    const adapter = adapterWith(fetchMock, { onError });

    await adapter.start(async () => {}, controller.signal);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(TelegramApiError),
      1_000,
    );
  });
});

describe('TelegramAdapter interactions and transport methods', () => {
  it('parses callback queries and answers them through Telegram', async () => {
    const controller = new AbortController();
    const requests: Array<{ operation: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const operation = String(input).split('/').pop() ?? '';
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ operation, body });
      if (operation === 'getUpdates' && body.timeout === 30) {
        return jsonResponse([{
          update_id: 12,
          callback_query: {
            id: 'callback-1',
            from: { id: 99, first_name: 'Ada' },
            message: {
              message_id: 55,
              chat: { id: -7, type: 'group' },
            },
            data: 'choose:one',
          },
        }]);
      }
      if (operation === 'getUpdates') return jsonResponse([]);
      return jsonResponse(true);
    });
    const adapter = adapterWith(fetchMock);
    let received: Parameters<Parameters<TelegramAdapter['start']>[0]>[0]
      | undefined;

    await adapter.start(async (message) => {
      received = message;
      await adapter.answerCallback('callback-1', 'Done', true);
      controller.abort();
    }, controller.signal);

    expect(received).toEqual({
      kind: 'callback_query',
      transport: 'telegram',
      messageId: '55',
      chatId: '-7',
      chatKind: 'group',
      senderId: '99',
      senderName: 'Ada',
      text: 'choose:one',
      callbackQueryId: 'callback-1',
      data: 'choose:one',
    });
    expect(requests.some(({ operation }) => operation === 'setMyCommands')).toBe(true);
    expect(requests.find(({ operation, body }) => (
      operation === 'getUpdates' && body.timeout === 30
    ))?.body.allowed_updates).toEqual(['message', 'callback_query']);
    expect(requests).toContainEqual({
      operation: 'answerCallbackQuery',
      body: {
        callback_query_id: 'callback-1',
        text: 'Done',
        show_alert: true,
      },
    });
  });

  it('serializes transport-neutral inline keyboards', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => (
      jsonResponse({ message_id: 321 })
    ));
    const adapter = adapterWith(fetchMock);

    const handle = await adapter.sendText('42', 'Pick', {
      keyboard: [[
        { text: 'Choose', callbackData: 'choice:1' },
        { text: 'Docs', url: 'https://example.com' },
      ]],
    });

    expect(handle).toEqual({ chatId: '42', messageId: '321' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      chat_id: '42',
      text: 'Pick',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Choose', callback_data: 'choice:1' },
          { text: 'Docs', url: 'https://example.com' },
        ]],
      },
    });
  });

  it('sends and edits messages using parsed Telegram HTML', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(true));
    const adapter = adapterWith(fetchMock);

    await adapter.sendText('42', '**Ready** & safe');
    await adapter.editText('42', '9', '# Updated\n`value`');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      chat_id: '42',
      text: '<b>Ready</b> &amp; safe',
      parse_mode: 'HTML',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      chat_id: '42',
      message_id: '9',
      text: '<b>Updated</b>\n<code>value</code>',
      parse_mode: 'HTML',
    });
  });

  it('replaces a placeholder and spills long formatted output safely', async () => {
    let nextMessageId = 20;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => (
      jsonResponse({ message_id: nextMessageId += 1 })
    ));
    const adapter = adapterWith(fetchMock);

    await adapter.replaceText('42', '9', `**${'x'.repeat(5_000)}**`, []);

    const requests = fetchMock.mock.calls.map((call) => ({
      operation: String(call[0]).split('/').pop(),
      body: JSON.parse(String(call[1]?.body)) as Record<string, unknown>,
    }));
    expect(requests[0]?.operation).toBe('editMessageText');
    expect(requests.slice(1).every(({ operation }) => operation === 'sendMessage')).toBe(true);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every(({ body }) => (
      body.parse_mode === 'HTML'
      && typeof body.text === 'string'
      && body.text.startsWith('<b>')
      && body.text.endsWith('</b>')
      && body.text.replace(/<[^>]+>/g, '').length <= 4_096
    ))).toBe(true);
  });

  it('captures Telegram error codes and retry-after metadata', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 4 },
      }),
      { status: 429 },
    ));
    const adapter = adapterWith(fetchMock);

    const error = await adapter.validate().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({
      errorCode: 429,
      retryAfter: 4,
      error_code: 429,
      retry_after: 4,
    });
  });
});
