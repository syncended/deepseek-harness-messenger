import { describe, expect, it, vi } from 'vitest';
import { MessengerBridge, parseCommand, type BridgeContext } from '../src/bridge.js';
import { splitTelegramText } from '../src/telegram.js';
import type {
  InboundCallbackInteraction,
  InboundTextMessage,
  MessengerAdapter,
  MessengerInlineKeyboard,
  MessengerMessageHandle,
  SendTextOptions,
} from '../src/types.js';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

function ok<T>(value: T) {
  return { rpcId: 'test-rpc', result: { ok: true as const, value } };
}

class FakeAdapter implements MessengerAdapter {
  readonly id = 'telegram';
  readonly sent: { chatId: string; text: string; options?: SendTextOptions }[] = [];
  readonly edits: { chatId: string; messageId: string; text: string; keyboard?: MessengerInlineKeyboard }[] = [];
  readonly answers: { id: string; text?: string; alert?: boolean }[] = [];
  readonly order: string[] = [];
  typing = 0;

  async start(): Promise<void> {}

  async sendText(chatId: string, text: string, options?: SendTextOptions): Promise<MessengerMessageHandle> {
    this.order.push(`send:${text}`);
    this.sent.push({ chatId, text, ...(options === undefined ? {} : { options }) });
    return { chatId, messageId: String(this.sent.length) };
  }

  async editText(
    chatId: string,
    messageId: string,
    text: string,
    keyboard?: MessengerInlineKeyboard,
  ): Promise<void> {
    this.edits.push({ chatId, messageId, text, ...(keyboard === undefined ? {} : { keyboard }) });
  }

  async answerCallback(id: string, text?: string, alert?: boolean): Promise<void> {
    this.order.push('answer');
    this.answers.push({ id, ...(text === undefined ? {} : { text }), ...(alert === undefined ? {} : { alert }) });
  }

  async sendTyping(): Promise<void> {
    this.typing += 1;
  }
}

function message(text: string): InboundTextMessage {
  return {
    kind: 'message',
    transport: 'telegram',
    messageId: randomId(),
    chatId: '100',
    chatKind: 'private',
    senderId: '100',
    text,
  };
}

function callback(data: string, senderId = '100'): InboundCallbackInteraction {
  return {
    kind: 'callback_query',
    transport: 'telegram',
    messageId: randomId(),
    chatId: '100',
    chatKind: 'private',
    senderId,
    text: data,
    data,
    callbackQueryId: randomId(),
  };
}

let sequence = 0;
function randomId(): string {
  sequence += 1;
  return String(sequence);
}

function fakeContext() {
  const summary = {
    sessionId: 'session-1',
    updatedAt: Date.now(),
    running: false,
    blank: false,
    cwd: '/workspace/project',
    projections: {
      asOfSeq: 1,
      values: {
        title: 'Messenger work',
        permissions: {
          currentValue: 'workspace-write',
          options: [{ value: 'workspace-write', name: 'Workspace write' }],
        },
        contextPressure: { projectedTokens: 12_000, contextWindow: 128_000 },
      },
    },
  };
  const models = {
    current: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    routable: true,
    groups: [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        reasoning: { efforts: [{ id: 'high', name: 'High' }] },
      }],
    }],
    failures: [],
  };
  const workspaces = [{
    workspaceId: 'workspace-1',
    path: '/workspace/project',
    title: 'Project',
    sessionIds: ['session-1'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }];
  let listed = [summary];
  const prompt = vi.fn(async () => ok({ accepted: true as const }));
  const sessions = {
    list: vi.fn(async () => ok({ items: listed })),
    models: vi.fn(async () => ok(models)),
    history: vi.fn(async () => ok({ events: [], hasMore: false, projections: summary.projections })),
    create: vi.fn(async (input: { payload: { workspaceId?: string } }) => {
      listed = [{ ...summary, sessionId: 'session-new' }];
      return ok({ sessionId: 'session-new', workspaceId: input.payload.workspaceId });
    }),
    prompt,
    cancel: vi.fn(async () => ok({ accepted: true as const })),
    selectModel: vi.fn(async (request: { payload: { provider: string; model: string; reasoningEffort?: string } }) => ok({
      selected: request.payload,
    })),
  };
  const workspace = {
    list: vi.fn(async () => ok({ items: workspaces, archivedSessionIds: [] })),
  };
  const agent = {
    id: 'session-1',
    status: 'idle',
    session: { events: [] },
    cancel: vi.fn(),
  };
  const ctx = {
    agents: {
      get: vi.fn((id: string) => id === 'session-1' ? agent : undefined),
    },
    apiProxy: { sessions, workspace },
    permissionPresets: {
      names: ['workspace-write'],
      defaultPreset: 'workspace-write',
      optionOf: (name: string) => ({ value: name, name }),
      set: vi.fn(),
    },
    logger: { warn: vi.fn() },
  } as unknown as BridgeContext;
  return { ctx, sessions, workspace, prompt, agent };
}

function firstCallback(adapter: FakeAdapter): string {
  const keyboard = adapter.sent.at(-1)?.options?.keyboard;
  const button = keyboard?.[0]?.[0];
  if (button === undefined || !('callbackData' in button)) throw new Error('callback button missing');
  return button.callbackData;
}

function callbackFor(adapter: FakeAdapter, text: string): string {
  const button = adapter.sent.at(-1)?.options?.keyboard
    ?.flat()
    .find((candidate) => candidate.text.includes(text));
  if (button === undefined || !('callbackData' in button)) throw new Error(`callback button "${text}" missing`);
  return button.callbackData;
}

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

describe('MessengerBridge controls', () => {
  it('lists persisted sessions with opaque, short callback data', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);

    await bridge.handle(message('/resume'));

    expect(adapter.sent[0]?.text).toContain('Choose a session');
    const data = firstCallback(adapter);
    expect(data).toMatch(/^m:[a-f0-9]{32}$/);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(data).not.toContain('session-1');
  });

  it('chooses a registered workspace before creating a session', async () => {
    const { ctx, sessions, workspace } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);

    await bridge.handle(message('/new'));

    expect(workspace.list).toHaveBeenCalledOnce();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(adapter.sent.at(-1)?.text).toContain('Choose a workspace');
    expect(callbackFor(adapter, 'Project')).toMatch(/^m:[a-f0-9]{32}$/);
    expect(callbackFor(adapter, 'Host default')).toMatch(/^m:[a-f0-9]{32}$/);

    await bridge.handle(callback(callbackFor(adapter, 'Project')));

    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      payload: { workspaceId: 'workspace-1' },
    }));
    expect(adapter.sent.some((entry) => entry.text.startsWith('Created '))).toBe(true);
    expect(adapter.sent.at(-1)?.text).toContain('Workspace: /workspace/project');
  });

  it('offers an explicit Host-default fallback when no workspace is registered', async () => {
    const { ctx, sessions, workspace } = fakeContext();
    workspace.list.mockResolvedValueOnce(ok({ items: [], archivedSessionIds: [] }));
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);

    await bridge.handle(message('/new'));

    expect(adapter.sent.at(-1)?.text).toContain('No registered workspaces');
    await bridge.handle(callback(callbackFor(adapter, 'Host default')));
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ payload: {} }));
  });

  it('answers callbacks before resuming and rejects a replay', async () => {
    const { ctx, sessions } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume'));
    const data = firstCallback(adapter);
    sessions.models.mockImplementationOnce(async () => {
      adapter.order.push('models');
      return ok({ current: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }, routable: true, groups: [], failures: [] });
    });

    await bridge.handle(callback(data));
    expect(adapter.order.indexOf('answer')).toBeLessThan(adapter.order.indexOf('models'));

    await bridge.handle(callback(data));
    expect(adapter.answers.at(-1)?.text).toContain('expired');
    expect(adapter.answers.at(-1)?.alert).toBe(true);
  });

  it('executes a claimed callback once when callback acknowledgement fails', async () => {
    const { ctx, sessions } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume'));
    const data = firstCallback(adapter);
    vi.spyOn(adapter, 'answerCallback').mockRejectedValueOnce(new Error('answer failed'));

    await bridge.handle(callback(data));

    expect(sessions.models).toHaveBeenCalled();
  });

  it('rejects callback tokens used by another sender', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: ['100', '999'],
      privateChatsOnly: false,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume'));
    const data = firstCallback(adapter);

    await bridge.handle(callback(data, '999'));

    expect(adapter.answers.at(-1)?.text).toContain('another operator');
    await bridge.handle(callback(data, '100'));
    expect(adapter.answers.at(-1)?.text).toBeUndefined();
  });

  it('rejects a session-scoped button after the binding changes', async () => {
    const { ctx, sessions } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    const modelButton = adapter.sent.at(-1)?.options?.keyboard
      ?.flat()
      .find((button) => button.text === 'Model');
    if (modelButton === undefined || !('callbackData' in modelButton)) {
      throw new Error('model button missing');
    }
    const callsBefore = sessions.models.mock.calls.length;

    await bridge.handle(message('/unbind'));
    await bridge.handle(callback(modelButton.callbackData));

    expect(adapter.answers.at(-1)?.text).toContain('stale');
    expect(sessions.models).toHaveBeenCalledTimes(callsBefore);
  });

  it('cancels through the canonical API that preserves queued work', async () => {
    const { ctx, sessions, agent } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    agent.status = 'running';

    await bridge.handle(message('/cancel'));

    expect(sessions.cancel).toHaveBeenCalledOnce();
    expect(agent.cancel).not.toHaveBeenCalled();
  });

  it('cleans up progress state when the initial placeholder send fails', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    const send = vi.spyOn(adapter, 'sendText');
    send.mockRejectedValueOnce(new Error('Telegram unavailable'));

    await expect(bridge.handle(message('first try'))).rejects.toThrow('Telegram unavailable');
    send.mockRestore();
    await bridge.handle(message('second try'));

    expect(adapter.sent.filter((entry) => entry.text === 'Deep diving…')).toHaveLength(1);
    await bridge.dispose();
  });

  it('fences queued mutations after disposal while draining admitted work', async () => {
    const { ctx, sessions, prompt } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    let release: (() => void) | undefined;
    prompt.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return ok({ accepted: true as const });
    });

    const admitted = bridge.handle(message('blocked prompt'));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    const queued = bridge.handle(message('/new')).catch((error: unknown) => error);
    const disposing = bridge.dispose();
    release?.();
    await admitted;
    expect(await queued).toBeInstanceOf(Error);
    await disposing;

    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('drops a failed final-delivery state before the next turn', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    await bridge.handle(message('first turn'));
    const edit = vi.spyOn(adapter, 'editText');
    edit.mockRejectedValueOnce(new Error('edit failed'));

    await expect(bridge.onSessionEvent('session-1', {
      type: 'turn/end',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as SessionEvent)).rejects.toThrow('edit failed');
    edit.mockRestore();

    await bridge.onSessionEvent('session-1', {
      type: 'turn/start',
      seq: 2,
      time: Date.now(),
      data: { turn: 2 },
    } as unknown as SessionEvent);
    expect(adapter.sent.filter((entry) => entry.text === 'Deep diving…')).toHaveLength(2);
    await bridge.dispose();
  });

  it('starts with Deep diving and progressively edits tool status and final text', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, prompt } = fakeContext();
      const adapter = new FakeAdapter();
      const bridge = new MessengerBridge(ctx, {
        allowedChatIds: ['100'],
        allowedUserIds: [],
        privateChatsOnly: true,
      });
      bridge.registerAdapter(adapter);
      await bridge.handle(message('/resume session-1'));
      await bridge.handle(message('Investigate latency'));

      expect(adapter.sent.some((entry) => entry.text === 'Deep diving…')).toBe(true);
      expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ mode: 'queue' }),
      }));

      await bridge.onSessionEvent('session-1', {
        type: 'tool/call',
        seq: 2,
        time: Date.now(),
        data: { turn: 1, step: 1, callId: 'call-1', name: 'functions.bash', arguments: '{}' },
      } as unknown as SessionEvent);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.edits.at(-1)?.text).toContain('🔧 functions.bash');

      await bridge.onSessionEvent('session-1', {
        type: 'assistant/chunk',
        seq: 3,
        time: Date.now(),
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(5_000) } },
      } as unknown as SessionEvent);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.edits.at(-1)?.text.startsWith('…\n')).toBe(true);
      expect(Array.from(adapter.edits.at(-1)?.text ?? '')).toHaveLength(4_096);

      await bridge.onSessionEvent('session-1', {
        type: 'assistant/message',
        seq: 4,
        time: Date.now(),
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'text', text: 'Done quickly.' }] },
        },
      } as unknown as SessionEvent);
      await bridge.onSessionEvent('session-1', {
        type: 'turn/end',
        seq: 5,
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'completed' } },
      } as unknown as SessionEvent);

      expect(adapter.edits.at(-1)?.text).toBe('Done quickly.');
      expect(adapter.edits.at(-1)?.keyboard).toEqual([]);
      await bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
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
