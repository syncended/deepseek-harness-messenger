import { describe, expect, it, vi } from 'vitest';
import { MessengerBridge, parseCommand, type BridgeContext } from '../src/bridge.js';
import { splitTelegramText } from '../src/telegram.js';
import type {
  InboundCallbackInteraction,
  InboundGenerationStopped,
  InboundTextMessage,
  MessengerAdapter,
  MessengerInlineKeyboard,
  MessengerMessageHandle,
  SendDraftOptions,
  SendTextOptions,
} from '../src/types.js';
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api';
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

class NativeDraftAdapter extends FakeAdapter {
  readonly drafts: {
    chatId: string;
    draftId: number;
    text: string;
    options?: SendDraftOptions;
  }[] = [];

  async sendDraft(
    chatId: string,
    draftId: number,
    text: string,
    options?: SendDraftOptions,
  ): Promise<void> {
    this.order.push(`draft:${text}`);
    this.drafts.push({
      chatId,
      draftId,
      text,
      ...(options === undefined ? {} : { options }),
    });
  }
}

function message(text: string, chatId = '100'): InboundTextMessage {
  return {
    kind: 'message',
    transport: 'telegram',
    messageId: randomId(),
    chatId,
    chatKind: 'private',
    senderId: chatId,
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

function generationStopped(draftId: number): InboundGenerationStopped {
  return {
    kind: 'generation_stopped',
    transport: 'telegram',
    messageId: String(draftId),
    chatId: '100',
    chatKind: 'private',
    senderId: '100',
    text: '',
    draftId,
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
  const respond = vi.fn(async (_request: unknown) => ({ accepted: true as const }));
  const ctx = {
    agents: {
      get: vi.fn((id: string) => id === 'session-1' ? agent : undefined),
    },
    apiProxy: { sessions, workspace, respond },
    permissionPresets: {
      names: ['workspace-write'],
      defaultPreset: 'workspace-write',
      optionOf: (name: string) => ({ value: name, name }),
      set: vi.fn(),
    },
    logger: { warn: vi.fn() },
  } as unknown as BridgeContext;
  return { ctx, sessions, workspace, prompt, respond, agent };
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

function latestCallbackFor(adapter: FakeAdapter, text: string): string {
  const keyboard = adapter.edits.at(-1)?.keyboard ?? adapter.sent.at(-1)?.options?.keyboard;
  const button = keyboard?.flat().find((candidate) => candidate.text.includes(text));
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
    expect(adapter.sent[0]?.options?.keyboard?.[0]?.[0]?.text).not.toContain('…');
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
    expect(adapter.sent.at(-1)?.text).toContain('📁 Project');
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

  it('accepts a group operator through a transport-provided sender alias', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: ['operator-login'],
      privateChatsOnly: false,
    });
    bridge.registerAdapter(adapter);

    await bridge.handle({
      ...message('/help'),
      chatKind: 'group',
      senderId: 'operator-uuid',
      senderAliases: ['operator-uuid', 'operator-login'],
    });

    expect(adapter.sent.at(-1)?.text).toContain('DeepSeek Harness messenger controls');
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

  it('renders a compact dashboard with UI workspace title and no session hash', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);

    await bridge.handle(message('/resume session-1'));

    const dashboard = adapter.sent.at(-1)?.text ?? '';
    expect(dashboard).toContain('Messenger work');
    expect(dashboard).toContain('⚪ idle  •  ✏️ workspace');
    expect(dashboard).toContain('deepseek/deepseek-chat  •  high');
    expect(dashboard).toContain('📁 Project');
    expect(dashboard).not.toContain('session-1');
  });

  it('groups model selection by provider before listing paginated models', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));

    await bridge.handle(message('/model'));
    expect(adapter.sent.at(-1)?.text).toContain('Choose a provider');
    expect(callbackFor(adapter, 'DeepSeek · 1')).toMatch(/^m:/);

    await bridge.handle(callback(callbackFor(adapter, 'DeepSeek · 1')));
    expect(adapter.sent.at(-1)?.text).toContain('DeepSeek · models · 1/1');
    expect(callbackFor(adapter, 'DeepSeek Chat')).toMatch(/^m:/);
  });

  it('answers a single-select DSH question through apiProxy.respond', async () => {
    const { ctx, respond } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    await bridge.handle(message('start a turn'));

    await bridge.onQuestionRequested(RpcId('question-rpc-1'), 'session-1', [{
      id: 'deploy',
      header: 'Confirm',
      question: 'Deploy now?',
      options: [
        { label: 'Deploy', description: 'Ship it' },
        { label: 'Wait' },
      ],
    }]);

    expect(adapter.edits.some((entry) => entry.text.includes('Waiting for your answer'))).toBe(true);
    expect(adapter.sent.at(-1)?.text).toContain('Deploy now?');
    await bridge.handle(callback(callbackFor(adapter, 'Deploy')));

    expect(respond).toHaveBeenCalledWith({
      type: 'client-response',
      rpcId: 'question-rpc-1',
      result: {
        ok: true,
        value: {
          sessionId: 'session-1',
          answer: { answers: [{ id: 'deploy', selected: ['Deploy'] }] },
        },
      },
    });
    expect(adapter.edits.at(-1)?.text).toBe('✅ Answer submitted.');
    await bridge.dispose();
  });

  it('retries showing a question after a transient transport failure', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = fakeContext();
      const adapter = new FakeAdapter();
      const bridge = new MessengerBridge(ctx, {
        allowedChatIds: ['100'],
        allowedUserIds: [],
        privateChatsOnly: true,
      });
      bridge.registerAdapter(adapter);
      await bridge.handle(message('/resume session-1'));
      vi.spyOn(adapter, 'sendText').mockRejectedValueOnce(new Error('temporary send failure'));

      await bridge.onQuestionRequested(RpcId('question-retry'), 'session-1', [{
        id: 'retry',
        question: 'Visible after retry?',
      }]);
      expect(adapter.sent.some((entry) => entry.text.includes('Visible after retry?'))).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(
        adapter.sent.some((entry) => entry.text.includes('Visible after retry?')),
      ).toBe(true));
      await bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues concurrent question RPCs for one session without overwriting either', async () => {
    const { ctx, respond } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));

    await bridge.onQuestionRequested(RpcId('question-rpc-first'), 'session-1', [{
      id: 'first',
      question: 'First decision?',
      options: [{ label: 'First answer' }],
    }]);
    await bridge.onQuestionRequested(RpcId('question-rpc-second'), 'session-1', [{
      id: 'second',
      question: 'Second decision?',
      options: [{ label: 'Second answer' }],
    }]);

    expect(adapter.sent.at(-1)?.text).toContain('First decision?');
    expect(adapter.sent.some((entry) => entry.text.includes('Second decision?'))).toBe(false);
    await bridge.handle(callback(callbackFor(adapter, 'First answer')));

    expect(adapter.sent.at(-1)?.text).toContain('Second decision?');
    await bridge.handle(callback(callbackFor(adapter, 'Second answer')));
    expect(respond.mock.calls.map(([request]) => (
      request as { rpcId: string }
    ).rpcId)).toEqual([
      'question-rpc-first',
      'question-rpc-second',
    ]);
    await bridge.dispose();
  });

  it('collects free text and multi-select answers across a question batch', async () => {
    const { ctx, respond } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));

    await bridge.onQuestionRequested(RpcId('question-rpc-2'), 'session-1', [{
      id: 'name',
      question: 'Release name?',
    }, {
      id: 'checks',
      question: 'Which checks?',
      multiSelect: true,
      options: [{ label: 'Tests' }, { label: 'Lint' }],
    }]);
    await bridge.handle(message('August release'));
    expect(adapter.edits.at(-1)?.text).toContain('Which checks?');

    const staleSubmit = latestCallbackFor(adapter, 'Submit');
    await bridge.handle(callback(latestCallbackFor(adapter, 'Tests')));
    await bridge.handle(callback(staleSubmit));
    expect(adapter.answers.at(-1)?.text).toContain('expired');
    expect(respond).not.toHaveBeenCalled();
    expect(adapter.edits.at(-1)?.keyboard?.flat().some(
      (button) => button.text.includes('Submit · 1 selected'),
    )).toBe(true);
    await bridge.handle(callback(latestCallbackFor(adapter, 'Submit')));

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      rpcId: 'question-rpc-2',
      result: {
        ok: true,
        value: {
          sessionId: 'session-1',
          answer: { answers: [
            { id: 'name', selected: [], custom: 'August release' },
            { id: 'checks', selected: ['Tests'] },
          ] },
        },
      },
    }));
    await bridge.dispose();
  });

  it('uses transport-aware length when a batch question cannot be edited', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    Object.assign(adapter, {
      textLimit: 4_096,
      textLength: (text: string) => text.length,
    });
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    await bridge.onQuestionRequested(RpcId('question-utf16-limit'), 'session-1', [{
      id: 'first',
      question: 'Short question?',
    }, {
      id: 'emoji',
      question: '🙂'.repeat(3_000),
    }]);
    const editsBefore = adapter.edits.length;

    await bridge.handle(message('first answer'));

    expect(adapter.edits).toHaveLength(editsBefore);
    expect(adapter.sent.at(-1)?.text).toContain('🙂'.repeat(100));
    await bridge.dispose();
  });

  it('keeps the visible question active when rendering the next batch item fails', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    await bridge.onQuestionRequested(RpcId('question-render-retry'), 'session-1', [{
      id: 'one',
      question: 'Question one?',
    }, {
      id: 'two',
      question: 'Question two?',
    }]);
    vi.spyOn(adapter, 'editText').mockRejectedValueOnce(new Error('temporary edit failure'));

    await bridge.handle(message('first answer'));
    expect(adapter.sent.at(-1)?.text).toContain('Could not submit that answer');
    await bridge.handle(message('retry answer'));

    expect(adapter.edits.at(-1)?.text).toContain('Question two?');
    await bridge.dispose();
  });

  it('rolls back a multi-select toggle when keyboard rendering fails', async () => {
    const { ctx, respond } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    await bridge.onQuestionRequested(RpcId('question-toggle-rollback'), 'session-1', [{
      id: 'checks',
      question: 'Select checks',
      multiSelect: true,
      options: [{ label: 'Tests' }],
    }]);
    const submit = latestCallbackFor(adapter, 'Submit');
    vi.spyOn(adapter, 'editText').mockRejectedValueOnce(new Error('temporary edit failure'));

    await bridge.handle(callback(latestCallbackFor(adapter, 'Tests')));
    await bridge.handle(callback(submit));

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        value: expect.objectContaining({
          answer: { answers: [{ id: 'checks', selected: [] }] },
        }),
      }),
    }));
    await bridge.dispose();
  });

  it('serializes external resolution behind an in-flight batch render', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    await bridge.onQuestionRequested(RpcId('question-resolution-race'), 'session-1', [{
      id: 'one',
      question: 'First?',
    }, {
      id: 'two',
      question: 'Second?',
    }]);
    let release: (() => void) | undefined;
    vi.spyOn(adapter, 'editText').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const answering = bridge.handle(message('answer'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const resolving = bridge.onQuestionResolved('question-resolution-race', 'answered');
    release?.();
    await answering;
    await resolving;

    expect(adapter.edits.at(-1)?.text).toBe('✅ Question resolved.');
    await bridge.dispose();
  });

  it('does not start typing when progress begins after a question is already pending', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    await bridge.onQuestionRequested(RpcId('question-before-progress'), 'session-1', [{
      id: 'wait',
      question: 'Wait for me?',
    }]);

    await bridge.onSessionEvent('session-1', {
      type: 'turn/start',
      seq: 1,
      time: Date.now(),
      data: { turn: 1 },
    } as unknown as SessionEvent);

    expect(adapter.typing).toBe(0);
    expect(adapter.sent.at(-1)?.text).toBe('❓ Waiting for your answer');
    await bridge.dispose();
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

  it('submits the prompt and cleans up when the initial placeholder send fails', async () => {
    const { ctx, prompt } = fakeContext();
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

    await expect(bridge.handle(message('first try'))).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        content: [{ type: 'text', text: 'first try' }],
        mode: 'queue',
      }),
    }));
    send.mockRestore();
    await bridge.handle(message('second try'));

    expect(adapter.sent.filter((entry) => entry.text.startsWith('✦ Exploring'))).toHaveLength(1);
    await bridge.dispose();
  });

  it('does not delay prompt submission behind a pending placeholder send', async () => {
    const { ctx, prompt } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    let release: (() => void) | undefined;
    vi.spyOn(adapter, 'sendText').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { chatId: '100', messageId: 'pending-progress' };
    });

    const handling = bridge.handle(message('start immediately'));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        content: [{ type: 'text', text: 'start immediately' }],
      }),
    }));
    release?.();
    await handling;
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

  it('isolates progress failures between bindings of the same session', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100', '200'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1', '100'));
    await bridge.handle(message('/resume session-1', '200'));
    const originalSend = adapter.sendText.bind(adapter);
    vi.spyOn(adapter, 'sendText').mockImplementation(async (chatId, text, options) => {
      if (chatId === '100') return new Promise<never>(() => {});
      return originalSend(chatId, text, options);
    });

    await expect(bridge.onSessionEvent('session-1', {
      type: 'turn/start',
      seq: 1,
      time: Date.now(),
      data: { turn: 1 },
    } as unknown as SessionEvent)).resolves.toBeUndefined();
    await bridge.onSessionEvent('session-1', {
      type: 'assistant/message',
      seq: 2,
      time: Date.now(),
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'Healthy binding result.' }] },
      },
    } as unknown as SessionEvent);
    await expect(bridge.onSessionEvent('session-1', {
      type: 'turn/end',
      seq: 3,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as SessionEvent)).resolves.toBeUndefined();

    await vi.waitFor(() => expect(adapter.edits).toContainEqual(expect.objectContaining({
      chatId: '200',
      text: 'Healthy binding result.',
    })));
    expect(ctx.logger.warn).not.toHaveBeenCalledWith(
      'messenger: failed to start progress for one binding: %o',
      expect.anything(),
    );
    await bridge.dispose();
  });

  it('uses native drafts for private-chat progress and persists the final answer', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = fakeContext();
      const adapter = new NativeDraftAdapter();
      const bridge = new MessengerBridge(ctx, {
        allowedChatIds: ['100'],
        allowedUserIds: [],
        privateChatsOnly: true,
      });
      bridge.registerAdapter(adapter);
      await bridge.handle(message('/resume session-1'));
      const sentBeforePrompt = adapter.sent.length;

      await bridge.handle(message('stream natively'));
      expect(adapter.drafts).toHaveLength(1);
      expect(adapter.drafts[0]?.options).toEqual({ canStop: true, keepOnStop: true });
      expect(adapter.sent).toHaveLength(sentBeforePrompt);

      await bridge.onSessionEvent('session-1', {
        type: 'assistant/chunk',
        seq: 1,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'Final answer.' },
        },
      } as unknown as SessionEvent);
      await vi.advanceTimersByTimeAsync(800);

      expect(adapter.drafts.at(-1)?.text).toContain('Final answer.');
      expect(adapter.drafts.at(-1)?.draftId).toBe(adapter.drafts[0]?.draftId);
      expect(adapter.edits).toHaveLength(0);

      await bridge.onSessionEvent('session-1', {
        type: 'turn/end',
        seq: 2,
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'completed' } },
      } as unknown as SessionEvent);
      await vi.waitFor(() => expect(adapter.sent.at(-1)?.text).toBe('Final answer.'));
      expect(adapter.edits).toHaveLength(0);
      await bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps edited-message progress as the group-chat fallback', async () => {
    const { ctx } = fakeContext();
    const adapter = new NativeDraftAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['-100'],
      allowedUserIds: ['200'],
      privateChatsOnly: false,
    });
    bridge.registerAdapter(adapter);
    const groupMessage = (text: string): InboundTextMessage => ({
      ...message(text, '-100'),
      chatKind: 'group',
      senderId: '200',
    });

    await bridge.handle(groupMessage('/resume session-1'));
    const sentBeforePrompt = adapter.sent.length;
    await bridge.handle(groupMessage('use the fallback'));

    expect(adapter.drafts).toHaveLength(0);
    expect(adapter.sent).toHaveLength(sentBeforePrompt + 1);
    expect(adapter.sent.at(-1)?.options?.keyboard?.[0]?.[0]?.text).toBe('Cancel');
    await bridge.dispose();
  });

  it('maps Telegram native draft stop controls to session cancellation', async () => {
    const { ctx, sessions, agent } = fakeContext();
    (agent as { status: string }).status = 'running';
    const adapter = new NativeDraftAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));
    await bridge.handle(message('cancel from Telegram'));
    const draftId = adapter.drafts[0]?.draftId;
    expect(draftId).toBeTypeOf('number');

    await bridge.handle(generationStopped(draftId!));

    expect(sessions.cancel).toHaveBeenCalledWith(expect.objectContaining({
      payload: { sessionId: 'session-1' },
    }));
    await bridge.dispose();
  });

  it('uses transport-specific rich-text rendering for assistant messages', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const renderText = vi.fn((text: string) => `rendered:${text}`);
    Object.assign(adapter, { renderText });
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume session-1'));

    await bridge.onSessionEvent('session-1', {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      surfaceOp: 'append',
      data: {
        interrupted: false,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: [{ type: 'text', text: '# Heading' }],
        },
      },
    } as unknown as SessionEvent);

    expect(renderText).toHaveBeenCalledWith('# Heading');
    expect(adapter.sent.at(-1)?.text).toBe('rendered:# Heading');
    await bridge.dispose();
  });

  it('truncates source before rich rendering so markup stays balanced', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = fakeContext();
      const adapter = new FakeAdapter();
      Object.assign(adapter, {
        textLimit: 120,
        renderText: (text: string) => `<b>${text}</b>`,
      });
      const bridge = new MessengerBridge(ctx, {
        allowedChatIds: ['100'],
        allowedUserIds: [],
        privateChatsOnly: true,
      });
      bridge.registerAdapter(adapter);
      await bridge.handle(message('/resume session-1'));
      await bridge.handle(message('stream a long answer'));

      await bridge.onSessionEvent('session-1', {
        type: 'assistant/chunk',
        seq: 1,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(500) },
        },
      } as unknown as SessionEvent);
      await vi.advanceTimersByTimeAsync(800);

      const edited = adapter.edits.at(-1)?.text ?? '';
      expect(Array.from(edited).length).toBeLessThanOrEqual(120);
      expect(edited).toMatch(/^<b>…\n/);
      expect(edited).toContain('</b>\n\n');
      expect(edited.match(/<b>/g)).toHaveLength(1);
      expect(edited.match(/<\/b>/g)).toHaveLength(1);
      await bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
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
    } as unknown as SessionEvent)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(ctx.logger.warn).toHaveBeenCalledWith(
      'messenger: failed to finalize progress for one binding: %o',
      expect.any(Error),
    ));
    edit.mockRestore();

    await bridge.onSessionEvent('session-1', {
      type: 'turn/start',
      seq: 2,
      time: Date.now(),
      data: { turn: 2 },
    } as unknown as SessionEvent);
    expect(adapter.sent.some((entry) => entry.text.startsWith('✦ Exploring'))).toBe(true);
    await bridge.dispose();
  });

  it('coalesces animation frames while one progress edit is in flight', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = fakeContext();
      const adapter = new FakeAdapter();
      const bridge = new MessengerBridge(ctx, {
        allowedChatIds: ['100'],
        allowedUserIds: [],
        privateChatsOnly: true,
      });
      bridge.registerAdapter(adapter);
      await bridge.handle(message('/resume session-1'));
      await bridge.handle(message('slow transport'));
      const originalEdit = adapter.editText.bind(adapter);
      let release: (() => void) | undefined;
      const edit = vi.spyOn(adapter, 'editText').mockImplementationOnce(async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await originalEdit(...args);
      });

      await vi.advanceTimersByTimeAsync(1_600);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(16_000);
      expect(edit).toHaveBeenCalledTimes(1);

      await bridge.onSessionEvent('session-1', {
        type: 'assistant/message',
        seq: 1,
        time: Date.now(),
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'text', text: 'Final answer.' }] },
        },
      } as unknown as SessionEvent);
      await bridge.onSessionEvent('session-1', {
        type: 'turn/end',
        seq: 2,
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'completed' } },
      } as unknown as SessionEvent);
      expect(edit).toHaveBeenCalledTimes(1);
      const sentBeforeNextTurn = adapter.sent.length;
      await bridge.onSessionEvent('session-1', {
        type: 'turn/start',
        seq: 3,
        time: Date.now(),
        data: { turn: 2 },
      } as unknown as SessionEvent);
      expect(adapter.sent.length).toBe(sentBeforeNextTurn + 1);

      release?.();
      await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
      expect(adapter.edits.at(-1)?.text).toBe('Final answer.');
      await bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cycles through all generic activity labels before repeating one', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = fakeContext();
      const adapter = new FakeAdapter();
      const bridge = new MessengerBridge(ctx, {
        allowedChatIds: ['100'],
        allowedUserIds: [],
        privateChatsOnly: true,
      });
      bridge.registerAdapter(adapter);
      await bridge.handle(message('/resume session-1'));
      await bridge.handle(message('long investigation'));
      const labels = [adapter.sent.at(-1)?.text.match(/^. (.+?)…/)?.[1]];

      for (let index = 1; index <= 16; index += 1) {
        await vi.advanceTimersByTimeAsync(4_800);
        labels.push(adapter.edits.at(-1)?.text.match(/^. (.+?)…/)?.[1]);
      }

      expect(new Set(labels.slice(0, 16))).toHaveLength(16);
      expect(labels[16]).toBe(labels[0]);
      await bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a concise completed-tool trail with argument-aware labels', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = fakeContext();
      const adapter = new FakeAdapter();
      const bridge = new MessengerBridge(ctx, {
        allowedChatIds: ['100'],
        allowedUserIds: [],
        privateChatsOnly: true,
      });
      bridge.registerAdapter(adapter);
      await bridge.handle(message('/resume session-1'));
      await bridge.handle(message('Find the progress renderer'));

      await bridge.onSessionEvent('session-1', {
        type: 'tool/call',
        seq: 2,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          callId: 'search-1',
          name: 'functions.grep',
          arguments: JSON.stringify({ pattern: 'progressText', path: 'src' }),
        },
      } as unknown as SessionEvent);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.edits.at(-1)?.text).toContain('Searching for “progressText” in src…');

      await bridge.onSessionEvent('session-1', {
        type: 'tool/result',
        seq: 3,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          message: { source: { callId: 'search-1' }, content: [] },
        },
      } as unknown as SessionEvent);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.edits.at(-1)?.text).toContain('✓ Searching for “progressText” in src');

      const todoEvent = {
        type: 'todo/write',
        seq: 4,
        time: Date.now(),
        data: { todos: [{ content: 'Check it', status: 'in_progress' }] },
      } as unknown as SessionEvent;
      await bridge.onSessionEvent('session-1', todoEvent);
      await bridge.onSessionEvent('session-1', todoEvent);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.edits.at(-1)?.text.match(/Checklist 0\/1/g)).toHaveLength(1);
      await bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('animates progress, describes tool work, and finishes with the final text', async () => {
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

      expect(adapter.sent.some((entry) => entry.text.startsWith('✦ Thinking'))).toBe(true);
      await vi.advanceTimersByTimeAsync(1_600);
      expect(adapter.edits.at(-1)?.text).toMatch(/^✧ Thinking…/);
      expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ mode: 'queue' }),
      }));

      await bridge.onSessionEvent('session-1', {
        type: 'tool/call',
        seq: 2,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          callId: 'call-1',
          name: 'functions.bash',
          arguments: JSON.stringify({ command: 'pnpm test', description: 'Run the test suite' }),
        },
      } as unknown as SessionEvent);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.edits.at(-1)?.text).toContain('Run the test suite…');

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

      await vi.waitFor(() => expect(adapter.edits.at(-1)?.text).toBe('Done quickly.'));
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
