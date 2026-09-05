import { describe, expect, it, vi } from 'vitest';
import type { InboundMessengerMessage, InboundVoiceMessage } from '../src/types.js';
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

const voiceMessage: InboundVoiceMessage = {
  kind: 'voice', transport: 'telegram', chatId: '42', messageId: '8',
  senderId: '42', text: '', voice: { fileId: 'voice-id', durationSeconds: 5 },
};
const voiceLimit = 20 * 1024 * 1024;

async function mapVoiceUpdates(messages: object[]): Promise<{
  received: InboundMessengerMessage[];
  fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
}> {
  const controller = new AbortController();
  const received: InboundMessengerMessage[] = [];
  const fetchMock = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(jsonResponse(true))
    .mockResolvedValueOnce(jsonResponse(true))
    .mockResolvedValueOnce(jsonResponse([
      ...messages.map((message, index) => ({ update_id: index + 1, message })),
      messageUpdate(messages.length + 1, 999, 42, 'stop'),
    ]))
    .mockResolvedValue(jsonResponse([]));
  await adapterWith(fetchMock).start(async (message) => {
    if (message.text === 'stop') controller.abort();
    else received.push(message);
  }, controller.signal);
  return { received, fetchMock };
}

function rawVoice(extra: object = {}): object {
  return {
    message_id: 8, chat: { id: 42, type: 'private' },
    from: { id: 42, username: 'speaker' },
    voice: { file_id: 'voice-id', duration: 5, file_size: 3, mime_type: 'audio/ogg' },
    ...extra,
  };
}

describe('TelegramAdapter voice mapping', () => {
  it('maps voice metadata without downloading and acknowledges before delivery', async () => {
    const { received, fetchMock } = await mapVoiceUpdates([rawVoice()]);
    expect(received).toEqual([{
      ...voiceMessage, chatKind: 'private', senderName: '@speaker',
      voice: { fileId: 'voice-id', durationSeconds: 5, sizeBytes: 3, mimeType: 'audio/ogg' },
    }]);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('getFile'))).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({ offset: 3, timeout: 0 });
  });

  it('requires a real explicit sender and does not treat audio or documents as voice', async () => {
    const { received } = await mapVoiceUpdates([
      rawVoice({ from: undefined }), rawVoice({ from: null }),
      rawVoice({ from: { id: '42' } }), rawVoice({ from: { id: 0 } }),
      rawVoice({ from: { id: 42, is_bot: true } }),
      rawVoice({ sender_chat: { id: 42 } }),
      rawVoice({ voice: undefined, audio: { file_id: 'audio' } }),
      rawVoice({ voice: undefined, document: { file_id: 'doc' } }),
    ]);
    expect(received).toEqual([]);
  });

  it('rejects malformed duration and size metadata but accepts absent optional fields', async () => {
    const invalid = [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', null];
    const { received } = await mapVoiceUpdates([
      ...invalid.map((duration) => rawVoice({ voice: { file_id: 'voice-id', duration } })),
      ...[...invalid, 1.5].map((file_size) => rawVoice({
        voice: { file_id: 'voice-id', duration: 5, file_size },
      })),
      rawVoice({ voice: { file_id: '', duration: 5 } }),
      rawVoice({ voice: { file_id: 'voice-id', duration: 0 } }),
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ voice: { fileId: 'voice-id', durationSeconds: 0 } });
    expect(received[0]).not.toHaveProperty('voice.sizeBytes');
  });
});

describe('TelegramAdapter voice download', () => {
  it('uses getFile then the fixed Telegram file endpoint and collects streamed bytes', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ file_path: 'voice/file_9.oga', file_size: 3 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    expect(await adapterWith(fetchMock).downloadVoice(voiceMessage, new AbortController().signal))
      .toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.telegram.org/bottest-token/getFile');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ file_id: 'voice-id' });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.telegram.org/file/bottest-token/voice/file_9.oga');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it.each(['message', 'getFile', 'content-length'])('rejects oversized advertised %s size', async (source) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({
        file_path: 'voice/file.oga', ...(source === 'getFile' ? { file_size: voiceLimit + 1 } : {}),
      }))
      .mockResolvedValueOnce(new Response('small', { headers: { 'content-length': String(voiceLimit + 1) } }));
    const message = source === 'message'
      ? { ...voiceMessage, voice: { ...voiceMessage.voice, sizeBytes: voiceLimit + 1 } }
      : voiceMessage;
    await expect(adapterWith(fetchMock).downloadVoice(message, new AbortController().signal)).rejects.toThrow('20 MB');
    expect(fetchMock).toHaveBeenCalledTimes(source === 'message' ? 0 : source === 'getFile' ? 1 : 2);
  });

  it.each([undefined, '1'])('enforces the streamed limit despite content-length %s', async (advertised) => {
    const cancel = vi.fn();
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(index++ < 20 ? 1024 * 1024 : 1));
      },
      cancel,
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ file_path: 'voice/file.oga', file_size: 1 }))
      .mockResolvedValueOnce(new Response(body, advertised === undefined ? {} : {
        headers: { 'content-length': advertised },
      }));
    await expect(adapterWith(fetchMock).downloadVoice(voiceMessage, new AbortController().signal))
      .rejects.toThrow('20 MB');
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    '../secret', 'voice/../secret', '/voice/file.oga', 'https://evil.test/a',
    '//evil.test/a', 'voice/%2e%2e/a', 'voice/a?token=x', 'voice/a#x',
    'voice\\file.oga', 'voice//file.oga', 'voice/./file.oga', '', null,
  ])('rejects unsafe getFile path %s without fetching it', async (file_path) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ file_path }));
    await expect(adapterWith(fetchMock).downloadVoice(voiceMessage, new AbortController().signal))
      .rejects.toThrow('invalid Telegram file path');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['request', 'runtime', 'timeout'])('aborts stalled streaming via %s', async (source) => {
    const request = new AbortController();
    const runtime = new AbortController();
    const cancel = vi.fn();
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ file_path: 'voice/file.oga' }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
    const adapter = new TelegramAdapter({
      token: 'test-token', pollTimeoutSeconds: 30, requestTimeoutMs: source === 'timeout' ? 20 : 1000,
      fetch: fetchMock, signal: runtime.signal,
    });
    const pending = expect(adapter.downloadVoice(voiceMessage, request.signal)).rejects.toThrow('aborted or timed out');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    if (source === 'request') request.abort(new Error('secret reason test-token'));
    if (source === 'runtime') runtime.abort(new Error('secret reason test-token'));
    await pending;
    expect(cancel).toHaveBeenCalled();
  });

  it('accepts exactly the byte limit', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ file_path: 'voice/a' }))
      .mockResolvedValueOnce(new Response(new Uint8Array(voiceLimit)));
    const bytes = await adapterWith(fetchMock).downloadVoice(voiceMessage, new AbortController().signal);
    expect(bytes.byteLength).toBe(voiceLimit);
  });

  it.each(['getFile', 'download'])('aborts a stalled %s request even if fetch ignores abort', async (stage) => {
    const request = new AbortController();
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (stage === 'download' && String(url).endsWith('/getFile')) {
        return jsonResponse({ file_path: 'voice/a' });
      }
      return await new Promise<Response>(() => {});
    });
    const pending = expect(adapterWith(fetchMock).downloadVoice(voiceMessage, request.signal))
      .rejects.toThrow('aborted or timed out');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(stage === 'getFile' ? 1 : 2));
    request.abort();
    await pending;
  });

  it.each([-1, 0.5, 'secret', null])('rejects invalid getFile size %s', async (file_size) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ file_path: 'voice/a', file_size }));
    await expect(adapterWith(fetchMock).downloadVoice(voiceMessage, new AbortController().signal))
      .rejects.toThrow('invalid voice size');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reflect file HTTP failure bodies', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ file_path: 'voice/a' }))
      .mockResolvedValueOnce(new Response('secret test-token', { status: 403 }));
    await expect(adapterWith(fetchMock).downloadVoice(voiceMessage, new AbortController().signal))
      .rejects.toThrow('Telegram downloadVoice failed: HTTP 403');
  });

  it('makes no request when already aborted', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    await expect(adapterWith(fetchMock).downloadVoice(voiceMessage, AbortSignal.abort('test-token')))
      .rejects.toThrow('aborted or timed out');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['getFile', 'download', 'stream', 'api-description', 'credential', 'abort'])('redacts %s failures', async (source) => {
    const secret = 'https://api.telegram.org/file/bottest-token/voice/a';
    const request = new AbortController();
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (source === 'getFile') throw new Error(secret);
      if (source === 'api-description') return new Response(JSON.stringify({
        ok: false, description: `Bad request ${secret} test-token https://user:password@evil.test/a`,
      }), { status: 400 });
      if (String(url).endsWith('/getFile')) return jsonResponse({ file_path: 'voice/a' });
      if (source === 'abort') request.abort(new Error(secret));
      if (source === 'stream') return new Response(new ReadableStream({
        start(controller) { controller.error(new Error(secret)); },
      }));
      throw new Error(secret);
    });
    const adapter = new TelegramAdapter({
      token: source === 'credential' ? async () => { throw new Error(secret); } : 'test-token',
      pollTimeoutSeconds: 30, requestTimeoutMs: 1000, fetch: fetchMock,
    });
    const error: unknown = await adapter.downloadVoice(voiceMessage, request.signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    const serialized = `${String(error)} ${JSON.stringify(error)}`;
    expect(serialized).not.toContain('test-token');
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain('password');
  });
});

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
      'voice_cancel',
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
