import { describe, expect, it, vi } from 'vitest';
import { MessengerBridge, parseCommand, type BridgeContext } from '../src/bridge.js';
import { splitTelegramText } from '../src/telegram.js';
import { NotificationStore, NOTIFICATION_LINK_TTL_MS } from '../src/notification-store.js';
import { MemoryMessengerBindingStore } from '../src/store.js';
import type {
  InboundCallbackInteraction,
  InboundImageMessage,
  InboundTextMessage,
  InboundVoiceMessage,
  MessengerAdapter,
  MessengerImage,
  MessengerInlineKeyboard,
  MessengerMessageHandle,
  SendTextOptions,
} from '../src/types.js';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { VoiceTranscriber } from '../src/voice.js';

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
    id: 'workspace-1',
    path: '/workspace/project',
    title: 'Project',
    sessionIds: ['session-1'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }];
  let listed = [summary];
  const prompt = vi.fn(async () => ({ accepted: true as const }));
  const agent = {
    id: 'session-1',
    status: 'idle',
    options: models.current,
    session: { events: [] },
    cancel: vi.fn(),
  };
  const sessions = {
    list: vi.fn(async () => ({ items: listed })),
    resolveAgent: vi.fn(async () => ({ agent })),
    modelCatalog: vi.fn(async () => ({
      default: models.current,
      routableProviders: ['deepseek'],
      groups: models.groups,
      failures: models.failures,
    })),
    create: vi.fn(async (input: { workspaceId?: string }) => {
      listed = [{ ...summary, sessionId: 'session-new' }];
      return { sessionId: 'session-new', workspaceId: input.workspaceId };
    }),
    prompt,
    cancel: vi.fn(async () => ({ accepted: true as const })),
    selectModel: vi.fn(async (request: { provider: string; model: string; reasoningEffort?: string }) => ({
      selected: request,
    })),
  };
  const workspace = {
    list: vi.fn(() => workspaces),
  };
  const respond = vi.fn(async (_answer: unknown) => true);
  const ctx = {
    agents: {
      get: vi.fn((id: string) => id === 'session-1' ? agent : undefined),
    },
    sessionController: sessions,
    workspaceRegistry: workspace,
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

function submitWith(
  respond: ReturnType<typeof vi.fn>,
  rpcId: string,
  sessionId = 'session-1',
) {
  return async (answer: unknown): Promise<boolean> => {
    await respond({ rpcId, sessionId, answer });
    return true;
  };
}

describe('MessengerBridge notifications', () => {
  async function setup(chats = ['100']) {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: chats,
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    for (const chat of chats) await bridge.handle(message('/resume session-1', chat));
    adapter.sent.length = 0;
    return { bridge, adapter };
  }

  it('sends separate rendered messages to all and only the current session bindings', async () => {
    const { bridge, adapter } = await setup(['100', '200']);
    const render = vi.fn((text: string) => `rendered:${text}`);
    Object.assign(adapter, { renderText: render });
    expect(await bridge.notify('session-1', '**Done**')).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(adapter.sent).toEqual([
      { chatId: '100', text: 'rendered:**Done**' },
      { chatId: '200', text: 'rendered:**Done**' },
    ]);
    expect(adapter.edits).toEqual([]);
    await expect(bridge.notify('other-session', 'No')).rejects.toThrow('No messenger chat');
    await bridge.dispose();
  });

  it('rejects blank, oversized, unbound, disposed and already cancelled sends', async () => {
    const { bridge, adapter } = await setup();
    await expect(bridge.notify('session-1', '  ')).rejects.toThrow('not be blank');
    await expect(bridge.notify('session-1', 'x'.repeat(16_001))).rejects.toThrow('16000');
    await expect(bridge.notify('session-1', 'No', AbortSignal.abort())).rejects.toThrow();
    expect(adapter.sent).toEqual([]);
    await bridge.handle(message('/unbind'));
    await expect(bridge.notify('session-1', 'No')).rejects.toThrow('No messenger chat');
    await bridge.dispose();
    await expect(bridge.notify('session-1', 'No')).rejects.toThrow('disposed');
  });

  it('reports partial failures without exposing transport errors or retrying delivered messages', async () => {
    const { bridge, adapter } = await setup(['100', '200']);
    vi.spyOn(adapter, 'sendText').mockImplementation(async (chatId) => {
      if (chatId === '100') throw new Error('secret transport error');
      return { chatId, messageId: '1' };
    });
    expect(await bridge.notify('session-1', 'Done')).toEqual({ sent: 1, failed: 1, skipped: 0 });
    expect(adapter.sendText).toHaveBeenCalledTimes(2);
    await bridge.dispose();
  });

  it.each(['cancel', 'dispose'])('skips queued sends on %s', async (action) => {
    const { bridge, adapter } = await setup();
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const original = adapter.sendText.bind(adapter);
    vi.spyOn(adapter, 'sendText').mockImplementation(async (chatId, text, options) => {
      if (text === 'First') { started(); await blocked; }
      return original(chatId, text, options);
    });
    const first = bridge.notify('session-1', 'First');
    await entered;
    const controller = new AbortController();
    const second = bridge.notify('session-1', 'Second', controller.signal);
    const stopping = action === 'dispose' ? bridge.dispose() : undefined;
    if (action === 'cancel') controller.abort();
    release();
    await first;
    expect(await second).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(adapter.sent.some((item) => item.text === 'Second')).toBe(false);
    await stopping;
    await bridge.dispose();
  });

  it('drops queued notifications after unbinding and rebinding the same session', async () => {
    const { bridge, adapter } = await setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = adapter.sendText.bind(adapter);
    vi.spyOn(adapter, 'sendText').mockImplementation(async (chatId, text, options) => {
      if (text === 'First') await blocked;
      return original(chatId, text, options);
    });
    const first = bridge.notify('session-1', 'First');
    const second = bridge.notify('session-1', 'Second');
    await bridge.handle(message('/unbind'));
    await bridge.handle(message('/resume session-1'));
    release();
    await first;
    expect(await second).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(adapter.sent.some((item) => item.text === 'Second')).toBe(false);
    await bridge.dispose();
  });
});

describe('persistent notification subscriptions', () => {
  function setup() {
    const transport = 'telegram';
    const context = fakeContext();
    let persisted: unknown = { subscriptions: [], links: [] };
    let now = Date.now();
    const save = vi.fn(async (value: unknown) => { persisted = structuredClone(value); });
    const makeStore = () => new NotificationStore(persisted, save, () => now);
    const store = makeStore();
    const makeBridge = (notificationStore = store, chats = ['100']) => {
      const adapter = new FakeAdapter();
      const bridge = new MessengerBridge(context.ctx, {
        notificationStore, allowedChatIds: chats, allowedUserIds: ['100'], privateChatsOnly: false,
      });
      bridge.registerAdapter(adapter);
      return { bridge, adapter };
    };
    const inbound = (text: string, chatId = '100') => ({ ...message(text, chatId), transport });
    const click = (data: string, senderId = '100') => ({ ...callback(data, senderId), transport });
    return { ...context, ...makeBridge(), store, makeStore, makeBridge, inbound, click, save,
      expire: () => { now += NOTIFICATION_LINK_TTL_MS + 1; } };
  }

  it('notifies an unbound Telegram subscriber and opens source only on click', async () => {
    const { bridge, adapter, inbound, click, prompt } = setup();
    await bridge.handle(inbound('/notifications on'));
    expect(bridge.canNotify('session-1')).toBe(true);
    expect(await bridge.notify('session-1', 'Automation complete')).toEqual({ sent: 1, failed: 0, skipped: 0 });
    const data = firstCallback(adapter);
    expect(data).toMatch(/^n:[A-Za-z0-9_-]{32}$/);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(data).not.toContain('session-1');
    expect(adapter.sent.at(-1)?.options?.keyboard?.[0]?.[0]?.text).toBe('Открыть сессию');
    await bridge.handle(inbound('Before click'));
    expect(prompt).not.toHaveBeenCalled();
    await bridge.handle(click(data));
    await bridge.handle(inbound('After click'));
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }), expect.anything());
    await bridge.dispose();
  });

  it('keeps the currently selected session until the notification button is clicked', async () => {
    const { bridge, adapter, inbound, click, prompt, sessions } = setup();
    const original = (await sessions.list()).items[0]!;
    sessions.list.mockResolvedValue({ items: [original, { ...original, sessionId: 'automation-run' }] });
    await bridge.handle(inbound('/resume session-1'));
    await bridge.handle(inbound('/notifications on'));
    await bridge.notify('automation-run', 'New run status');
    const data = firstCallback(adapter);
    await bridge.handle(inbound('Current conversation'));
    expect(prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-1' }), expect.anything());
    await bridge.handle(click(data));
    await bridge.handle(inbound('Automation follow-up'));
    expect(prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'automation-run' }), expect.anything());
    await bridge.dispose();
  });

  it('preserves subscriptions and buttons across bridge and store restarts, and /unbind', async () => {
    const f = setup();
    await f.bridge.handle(f.inbound('/notifications on'));
    await f.bridge.notify('session-1', 'First');
    const data = firstCallback(f.adapter);
    await f.bridge.dispose();
    const restarted = f.makeBridge(f.makeStore());
    await restarted.bridge.notify('session-1', 'After restart');
    await restarted.bridge.handle(f.click(data));
    await restarted.bridge.handle(f.inbound('/unbind'));
    expect(await restarted.bridge.notify('session-1', 'Still subscribed')).toEqual({ sent: 1, failed: 0, skipped: 0 });
    await restarted.bridge.dispose();
  });

  it('does not subscribe automatically on /resume and fails closed if saving subscription fails', async () => {
    const { bridge, store, inbound, save } = setup();
    await bridge.handle(inbound('/resume session-1'));
    await expect(bridge.notify('session-1', 'No subscription')).rejects.toThrow('/notifications on');
    save.mockRejectedValueOnce(new Error('Disk full'));
    await bridge.handle(inbound('/notifications on'));
    expect(store.get('telegram', '100')).toBeUndefined();
    expect(bridge.canNotify('session-1')).toBe(false);
    await bridge.dispose();
  });

  it('does not deliver a notification if its durable button cannot be saved', async () => {
    const { bridge, adapter, inbound, save } = setup();
    await bridge.handle(inbound('/notifications on'));
    adapter.sent.length = 0;
    save.mockRejectedValueOnce(new Error('Storage unavailable'));
    expect(await bridge.notify('session-1', 'Must not be sent')).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(adapter.sent).toEqual([]);
    await bridge.dispose();
  });

  it('does not switch sessions when the subscription is revoked during source resolution', async () => {
    const { bridge, adapter, inbound, click, store, sessions, agent, prompt } = setup();
    await bridge.handle(inbound('/notifications on'));
    await bridge.notify('session-1', 'Done');
    const data = firstCallback(adapter);
    sessions.resolveAgent.mockImplementationOnce(async () => {
      await store.unsubscribe('telegram', '100');
      return { agent };
    });
    await bridge.handle(click(data));
    await bridge.handle(inbound('No active session'));
    expect(prompt).not.toHaveBeenCalled();
    await bridge.dispose();
  });

  it('blocks unauthorized subscription commands and foreign notification button clicks', async () => {
    const { bridge, adapter, store, inbound, click, sessions } = setup();
    await bridge.handle(inbound('/notifications on', '999'));
    expect(store.get('telegram', '999')).toBeUndefined();
    await bridge.handle(inbound('/notifications on'));
    await bridge.notify('session-1', 'Done');
    const data = firstCallback(adapter);
    sessions.resolveAgent.mockClear();
    await bridge.handle(click(data, 'other-user'));
    expect(adapter.answers.at(-1)?.alert).toBe(true);
    expect(sessions.resolveAgent).not.toHaveBeenCalled();
    await bridge.handle({ ...click(data), chatId: '999' });
    expect(sessions.resolveAgent).not.toHaveBeenCalled();
    await bridge.dispose();
  });

  it('invalidates buttons on unsubscribe even after re-subscribing', async () => {
    const { bridge, adapter, inbound, click, sessions } = setup();
    await bridge.handle(inbound('/notifications on'));
    await bridge.notify('session-1', 'Done');
    const data = firstCallback(adapter);
    await bridge.handle(inbound('/notifications off'));
    expect(bridge.canNotify('session-1')).toBe(false);
    await bridge.handle(inbound('/notifications on'));
    await bridge.handle(click(data));
    expect(adapter.answers.at(-1)?.alert).toBe(true);
    expect(sessions.resolveAgent).not.toHaveBeenCalled();
    await bridge.dispose();
  });

  it('rechecks allowlists on restart without leaking notifications to revoked chats', async () => {
    const f = setup();
    await f.bridge.handle(f.inbound('/notifications on'));
    await f.bridge.dispose();
    const restarted = f.makeBridge(f.makeStore(), ['200']);
    expect(restarted.bridge.canNotify('session-1')).toBe(false);
    await expect(restarted.bridge.notify('session-1', 'Private')).rejects.toThrow('No notification subscribers');
    expect(restarted.adapter.sent).toHaveLength(0);
    await restarted.bridge.dispose();
  });

  it('reports expired and deleted source sessions without switching an existing binding', async () => {
    const { bridge, adapter, inbound, click, expire, sessions, prompt } = setup();
    await bridge.handle(inbound('/resume session-1'));
    await bridge.handle(inbound('/notifications on'));
    await bridge.notify('missing-session', 'Deleted run');
    const data = firstCallback(adapter);
    await bridge.handle(click(data));
    expect(adapter.sent.at(-1)?.text).toContain('Could not open');
    await bridge.handle(inbound('Still original'));
    expect(prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-1' }), expect.anything());
    expire();
    sessions.resolveAgent.mockClear();
    await bridge.handle(click(data));
    expect(adapter.answers.at(-1)?.alert).toBe(true);
    expect(sessions.resolveAgent).not.toHaveBeenCalled();
    await bridge.dispose();
  });

  it('skips queued notifications after unsubscribe and persists a link before transport delivery', async () => {
    const { bridge, adapter, inbound, store } = setup();
    await bridge.handle(inbound('/notifications on'));
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const send = adapter.sendText.bind(adapter);
    vi.spyOn(adapter, 'sendText').mockImplementation(async (chatId, text, options) => {
      if (text === 'First') {
        const token = options?.keyboard?.[0]?.[0]?.callbackData?.slice(2);
        expect(token && store.link(token)).toBeTruthy();
        started(); await blocked;
      }
      return send(chatId, text, options);
    });
    const first = bridge.notify('session-1', 'First');
    await entered;
    const second = bridge.notify('session-1', 'Second');
    await bridge.handle(inbound('/notifications off'));
    release();
    await first;
    expect(await second).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(adapter.sent.some((item) => item.text === 'Second')).toBe(false);
    await bridge.dispose();
  });
});

describe('notification and per-user binding integration', () => {
  async function setup() {
    const context = fakeContext();
    const original = (await context.sessions.list()).items[0]!;
    context.sessions.list.mockResolvedValue({ items: [
      original,
      { ...original, sessionId: 'session-2' },
      { ...original, sessionId: 'automation-run' },
    ] });
    let persisted: unknown = { subscriptions: [], links: [] };
    const makeNotificationStore = () => new NotificationStore(persisted, async (state) => {
      persisted = structuredClone(state);
    });
    const notificationStore = makeNotificationStore();
    const bindingStore = new MemoryMessengerBindingStore();
    const bridges: MessengerBridge[] = [];
    const makeBridge = (
      bindings = bindingStore,
      notifications = notificationStore,
      legacy = false,
    ) => {
      const adapter = new FakeAdapter();
      const bridge = new MessengerBridge(context.ctx, {
        allowedChatIds: ['100'],
        allowedUserIds: ['alice', 'bob'],
        privateChatsOnly: false,
        ...(legacy ? {} : { notificationStore: notifications }),
      }, bindings);
      bridge.registerAdapter(adapter);
      bridges.push(bridge);
      return { bridge, adapter };
    };
    const inbound = (text: string, senderId = 'alice'): InboundTextMessage => ({
      ...message(text), chatKind: 'group', senderId,
    });
    const click = (data: string, senderId = 'alice'): InboundCallbackInteraction => ({
      ...callback(data, senderId), chatKind: 'group',
    });
    const cleanup = async () => {
      await Promise.all(bridges.map((bridge) => bridge.dispose()));
    };
    return { ...context, bindingStore, notificationStore, makeNotificationStore,
      makeBridge, inbound, click, cleanup };
  }

  it('opens a persisted notification only for its owner and restores that per-user selection', async () => {
    const f = await setup();
    try {
      const first = f.makeBridge();
      await first.bridge.handle(f.inbound('/resume session-1'));
      await first.bridge.handle(f.inbound('/resume session-2', 'bob'));
      await first.bridge.handle(f.inbound('/notifications on'));
      const before = structuredClone(f.bindingStore.list());
      expect(await first.bridge.notify('automation-run', 'Ready')).toEqual({ sent: 1, failed: 0, skipped: 0 });
      const token = firstCallback(first.adapter);
      expect(token).toMatch(/^n:/);
      expect(f.bindingStore.list()).toEqual(before);
      await first.bridge.dispose();

      const bindings = new MemoryMessengerBindingStore(structuredClone(f.bindingStore.list()));
      const restarted = f.makeBridge(bindings, f.makeNotificationStore());
      await restarted.bridge.restoreBindings();
      await restarted.bridge.handle(f.click(token, 'bob'));
      expect(restarted.adapter.answers.at(-1)?.alert).toBe(true);
      expect(bindings.list()).toEqual(before);
      await restarted.bridge.handle(f.click(token));
      expect(bindings.list().find((record) => record.senderId === 'alice')).toMatchObject({
        transport: 'telegram', chatId: '100', chatKind: 'group',
        authorizedAs: 'alice', sessionId: 'automation-run', sessionCwd: '/workspace/project',
      });
      expect(bindings.list().find((record) => record.senderId === 'bob')).toEqual(
        before.find((record) => record.senderId === 'bob'),
      );
      await restarted.bridge.dispose();

      const restored = f.makeBridge(
        new MemoryMessengerBindingStore(structuredClone(bindings.list())),
        f.makeNotificationStore(),
      );
      await restored.bridge.restoreBindings();
      await restored.bridge.handle(f.inbound('Owner follow-up'));
      expect(f.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'automation-run' }), expect.anything());
      await restored.bridge.handle(f.inbound('Other operator follow-up', 'bob'));
      expect(f.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-2' }), expect.anything());
    } finally {
      await f.cleanup();
    }
  });

  it('unbinds only the caller while preserving the chat subscription and persistent button', async () => {
    const f = await setup();
    try {
      const { bridge, adapter } = f.makeBridge();
      await bridge.handle(f.inbound('/resume session-1'));
      await bridge.handle(f.inbound('/resume session-2', 'bob'));
      await bridge.handle(f.inbound('/notifications on'));
      await bridge.notify('automation-run', 'Before unbind');
      const token = firstCallback(adapter);
      const subscription = f.notificationStore.get('telegram', '100');
      await bridge.handle(f.inbound('/unbind'));
      expect(f.bindingStore.list().map(({ senderId, sessionId }) => ({ senderId, sessionId })))
        .toEqual([{ senderId: 'bob', sessionId: 'session-2' }]);
      expect(f.notificationStore.get('telegram', '100')).toEqual(subscription);
      expect(f.notificationStore.link(token.slice(2))?.sessionId).toBe('automation-run');
      expect(await bridge.notify('automation-run', 'Still subscribed')).toEqual({ sent: 1, failed: 0, skipped: 0 });
      await bridge.handle(f.click(token));
      expect(f.bindingStore.list().find((record) => record.senderId === 'alice')?.sessionId).toBe('automation-run');
    } finally {
      await f.cleanup();
    }
  });

  it('keeps the old durable and live selection when a notification binding save fails', async () => {
    const f = await setup();
    try {
      const { bridge, adapter } = f.makeBridge();
      await bridge.handle(f.inbound('/resume session-1'));
      await bridge.handle(f.inbound('/resume session-2', 'bob'));
      await bridge.handle(f.inbound('/notifications on'));
      await bridge.notify('automation-run', 'Ready');
      const token = firstCallback(adapter);
      const before = structuredClone(f.bindingStore.list());
      vi.spyOn(f.bindingStore, 'put').mockRejectedValueOnce(new Error('Disk full'));
      await bridge.handle(f.click(token));
      expect(adapter.sent.at(-1)?.text).toContain('Could not open');
      expect(f.bindingStore.list()).toEqual(before);
      expect(f.notificationStore.link(token.slice(2))?.sessionId).toBe('automation-run');
      await bridge.handle(f.inbound('Still original'));
      expect(f.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-1' }), expect.anything());
      await bridge.handle(f.inbound('Still independent', 'bob'));
      expect(f.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-2' }), expect.anything());
    } finally {
      await f.cleanup();
    }
  });

  it('deduplicates legacy notifications to one chat with multiple per-user bindings', async () => {
    const f = await setup();
    try {
      const { bridge, adapter } = f.makeBridge(f.bindingStore, f.notificationStore, true);
      await bridge.handle(f.inbound('/resume session-1'));
      await bridge.handle(f.inbound('/resume session-1', 'bob'));
      expect(f.bindingStore.list()).toHaveLength(2);
      adapter.sent.length = 0;
      expect(await bridge.notify('session-1', 'Legacy status')).toEqual({ sent: 1, failed: 0, skipped: 0 });
      expect(adapter.sent).toEqual([{ chatId: '100', text: 'Legacy status' }]);
      await bridge.handle(f.inbound('/unbind'));
      adapter.sent.length = 0;
      expect(await bridge.notify('session-1', 'Remaining operator')).toEqual({ sent: 1, failed: 0, skipped: 0 });
      expect(adapter.sent).toEqual([{ chatId: '100', text: 'Remaining operator' }]);
    } finally {
      await f.cleanup();
    }
  });
});

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

  it('restores a per-user binding after bridge restart and keeps unbind durable', async () => {
    const { ctx, prompt } = fakeContext();
    const store = new MemoryMessengerBindingStore();
    const options = {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    };
    const first = new MessengerBridge(ctx, options, store);
    first.registerAdapter(new FakeAdapter());
    await first.handle(message('/resume session-1'));
    await first.dispose();

    const secondAdapter = new FakeAdapter();
    const second = new MessengerBridge(ctx, options, store);
    second.registerAdapter(secondAdapter);
    await second.restoreBindings();
    await second.handle(message('continue after restart'));

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      content: [{ type: 'text', text: 'continue after restart' }],
    }), expect.any(AbortSignal));

    await second.handle(message('/unbind'));
    await second.dispose();
    const thirdAdapter = new FakeAdapter();
    const third = new MessengerBridge(ctx, options, store);
    third.registerAdapter(thirdAdapter);
    await third.restoreBindings();
    const promptsBefore = prompt.mock.calls.length;
    await third.handle(message('must not be routed'));

    expect(prompt).toHaveBeenCalledTimes(promptsBefore);
    expect(thirdAdapter.sent.at(-1)?.text).toContain('No session selected');
    await third.dispose();
  });

  it('isolates bindings by operator within a group and persists alias authorization', async () => {
    const { ctx, prompt } = fakeContext();
    const adapter = new FakeAdapter();
    const store = new MemoryMessengerBindingStore();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: ['operator-login', 'other-login'],
      privateChatsOnly: false,
    }, store);
    bridge.registerAdapter(adapter);

    await bridge.handle({
      ...message('/resume session-1'),
      chatKind: 'group',
      senderId: 'operator-uuid',
      senderAliases: ['operator-uuid', 'operator-login'],
    });
    await bridge.handle({
      ...message('other operator text'),
      chatKind: 'group',
      senderId: 'other-uuid',
      senderAliases: ['other-uuid', 'other-login'],
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(adapter.sent.at(-1)?.text).toContain('No session selected');
    expect(store.list()).toEqual([expect.objectContaining({
      chatId: '100',
      chatKind: 'group',
      senderId: 'operator-uuid',
      authorizedAs: 'operator-login',
      sessionId: 'session-1',
    })]);
    await bridge.dispose();
  });

  it('prunes restored bindings revoked by policy or missing their session', async () => {
    const { ctx } = fakeContext();
    const store = new MemoryMessengerBindingStore([{
      transport: 'telegram',
      chatId: 'revoked-chat',
      chatKind: 'private',
      senderId: 'revoked-chat',
      sessionId: 'session-1',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }, {
      transport: 'telegram',
      chatId: '100',
      chatKind: 'private',
      senderId: '100',
      sessionId: 'missing-session',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }, {
      transport: 'telegram',
      chatId: '100',
      chatKind: 'private',
      senderId: 'other-lifecycle',
      sessionId: 'session-1',
      sessionCwd: '/replaced/session',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }]);
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    }, store);
    bridge.registerAdapter(new FakeAdapter());

    await bridge.restoreBindings();

    expect(store.list()).toEqual([]);
    await bridge.dispose();
  });

  it('retains unavailable transport rows without intercepting questions', async () => {
    const { ctx } = fakeContext();
    const foreign = {
      transport: 'discord',
      chatId: '100',
      chatKind: 'private' as const,
      senderId: '100',
      sessionId: 'session-1',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const store = new MemoryMessengerBindingStore([foreign]);
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    }, store);
    bridge.registerAdapter(new FakeAdapter());
    await bridge.restoreBindings();

    await expect(bridge.askQuestion('session-1', [{
      id: 'foreign',
      question: 'Must not be intercepted?',
    }])).resolves.toBeUndefined();
    expect(store.list()).toEqual([foreign]);
    await bridge.dispose();
  });

  it('restores an allowlisted binding when an adapter omits chat kind', async () => {
    const { ctx, prompt } = fakeContext();
    const store = new MemoryMessengerBindingStore([{
      transport: 'telegram',
      chatId: '100',
      senderId: 'operator',
      sessionId: 'session-1',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }]);
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: ['operator'],
      privateChatsOnly: false,
    }, store);
    bridge.registerAdapter(adapter);
    await bridge.restoreBindings();

    await bridge.handle({
      kind: 'message',
      transport: 'telegram',
      messageId: randomId(),
      chatId: '100',
      senderId: 'operator',
      text: 'restored without kind',
    });

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
    }), expect.any(AbortSignal));
    await bridge.dispose();
  });

  it('deduplicates passive output for users sharing one group session', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const store = new MemoryMessengerBindingStore();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: ['one', 'two'],
      privateChatsOnly: false,
    }, store);
    bridge.registerAdapter(adapter);
    await bridge.handle({ ...message('/resume session-1'), chatKind: 'group', senderId: 'one' });
    await bridge.handle({ ...message('/resume session-1'), chatKind: 'group', senderId: 'two' });
    const sentBefore = adapter.sent.length;

    await bridge.onSessionEvent('session-1', {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      surfaceOp: 'append',
      data: {
        message: { content: [{ type: 'text', text: 'One group delivery.' }] },
      },
    } as unknown as SessionEvent);

    expect(adapter.sent.slice(sentBefore).filter(
      (entry) => entry.text === 'One group delivery.',
    )).toHaveLength(1);
    await bridge.dispose();
  });

  it('shares one active progress message between group operators', async () => {
    const { ctx, prompt } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: ['one', 'two'],
      privateChatsOnly: false,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle({ ...message('/resume session-1'), chatKind: 'group', senderId: 'one' });
    await bridge.handle({ ...message('/resume session-1'), chatKind: 'group', senderId: 'two' });
    const sentBefore = adapter.sent.length;

    await bridge.handle({ ...message('first queued turn'), chatKind: 'group', senderId: 'one' });
    await bridge.handle({ ...message('second queued turn'), chatKind: 'group', senderId: 'two' });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(adapter.sent).toHaveLength(sentBefore + 1);
    await bridge.dispose();
  });

  it('keeps shared progress alive when a second group prompt is rejected', async () => {
    const { ctx, prompt } = fakeContext();
    prompt.mockResolvedValueOnce({ accepted: true }).mockRejectedValueOnce(new Error('queue rejected'));
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: ['one', 'two'],
      privateChatsOnly: false,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle({ ...message('/resume session-1'), chatKind: 'group', senderId: 'one' });
    await bridge.handle({ ...message('/resume session-1'), chatKind: 'group', senderId: 'two' });

    await bridge.handle({ ...message('accepted turn'), chatKind: 'group', senderId: 'one' });
    await bridge.handle({ ...message('rejected turn'), chatKind: 'group', senderId: 'two' });
    expect(adapter.sent.at(-1)?.text).toContain('Could not queue that prompt: queue rejected');
    await bridge.onSessionEvent('session-1', {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'Accepted result.' }] } },
    } as unknown as SessionEvent);
    await bridge.onSessionEvent('session-1', {
      type: 'turn/end',
      seq: 2,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as SessionEvent);

    await vi.waitFor(() => expect(adapter.edits.at(-1)?.text).toBe('Accepted result.'));
    await bridge.dispose();
  });

  it('keeps one group question and promotes it when its operator unbinds', async () => {
    const { ctx } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: ['one', 'two'],
      privateChatsOnly: false,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle({ ...message('/resume session-1'), chatKind: 'group', senderId: 'one' });
    await bridge.onQuestionRequested('group-question', 'session-1', [{
      id: 'confirm',
      question: 'Only one visible copy?',
      options: [{ label: 'Yes' }],
    }]);
    expect(adapter.sent.filter((entry) => entry.text.includes('Only one visible copy?'))).toHaveLength(1);

    await bridge.handle({ ...message('/resume session-1'), chatKind: 'group', senderId: 'two' });
    expect(adapter.sent.filter((entry) => entry.text.includes('Only one visible copy?'))).toHaveLength(1);

    await bridge.handle({ ...message('/unbind'), chatKind: 'group', senderId: 'one' });
    expect(adapter.sent.filter((entry) => entry.text.includes('Only one visible copy?'))).toHaveLength(2);
    await bridge.dispose();
  });

  it('does not retry a failed group question after another operator displays it', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = fakeContext();
      const adapter = new FakeAdapter();
      const bridge = new MessengerBridge(ctx, {
        allowedChatIds: ['100'],
        allowedUserIds: ['one', 'two'],
        privateChatsOnly: false,
      });
      bridge.registerAdapter(adapter);
      await bridge.handle({ ...message('/resume session-1'), chatKind: 'group', senderId: 'one' });
      vi.spyOn(adapter, 'sendText').mockRejectedValueOnce(new Error('temporary transport error'));
      await bridge.onQuestionRequested('retry-question', 'session-1', [{
        id: 'retry',
        question: 'Retry only once?',
        options: [{ label: 'Yes' }],
      }]);

      await bridge.handle({ ...message('/resume session-1'), chatKind: 'group', senderId: 'two' });
      await vi.advanceTimersByTimeAsync(600);

      expect(adapter.sent.filter((entry) => entry.text.includes('Retry only once?'))).toHaveLength(1);
      await bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
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
      workspaceId: 'workspace-1',
    }));
    expect(adapter.sent.some((entry) => entry.text.startsWith('Created '))).toBe(true);
    expect(adapter.sent.at(-1)?.text).toContain('📁 Project');
  });

  it('offers an explicit Host-default fallback when no workspace is registered', async () => {
    const { ctx, sessions, workspace } = fakeContext();
    workspace.list.mockReturnValueOnce([]);
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
    expect(sessions.create).toHaveBeenCalledWith({});
  });

  it('reports recovery instructions when a new session binding cannot be saved', async () => {
    const { ctx, sessions } = fakeContext();
    const adapter = new FakeAdapter();
    const store = new MemoryMessengerBindingStore();
    vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('storage full'));
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    }, store);
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/new'));

    await bridge.handle(callback(callbackFor(adapter, 'Host default')));

    expect(sessions.create).toHaveBeenCalledOnce();
    expect(store.list()).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain('was created, but its messenger binding could not be saved');
    expect(adapter.sent.at(-1)?.text).toContain('/sessions');
    await bridge.dispose();
  });

  it('reports the created session when its post-create catalog lookup fails', async () => {
    const { ctx, sessions } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/new'));
    sessions.list.mockRejectedValueOnce(new Error('catalog unavailable'));

    await bridge.handle(callback(callbackFor(adapter, 'Host default')));

    expect(sessions.create).toHaveBeenCalledOnce();
    expect(adapter.sent.at(-1)?.text).toContain('was created, but its messenger binding could not be saved');
    expect(adapter.sent.at(-1)?.text).toContain('/sessions');
    await bridge.dispose();
  });

  it('answers callbacks before resuming and rejects a replay', async () => {
    const { ctx, sessions, agent } = fakeContext();
    const adapter = new FakeAdapter();
    const bridge = new MessengerBridge(ctx, {
      allowedChatIds: ['100'],
      allowedUserIds: [],
      privateChatsOnly: true,
    });
    bridge.registerAdapter(adapter);
    await bridge.handle(message('/resume'));
    const data = firstCallback(adapter);
    sessions.resolveAgent.mockImplementationOnce(async () => {
      adapter.order.push('models');
      return { agent };
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

    expect(sessions.resolveAgent).toHaveBeenCalled();
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

  it('answers a single-select DSH question through the Host waterfall', async () => {
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

    await bridge.onQuestionRequested('question-rpc-1', 'session-1', [{
      id: 'deploy',
      header: 'Confirm',
      question: 'Deploy now?',
      options: [
        { label: 'Deploy', description: 'Ship it' },
        { label: 'Wait' },
      ],
    }], submitWith(respond, 'question-rpc-1'));

    expect(adapter.edits.some((entry) => entry.text.includes('Waiting for your answer'))).toBe(true);
    expect(adapter.sent.at(-1)?.text).toContain('Deploy now?');
    await bridge.handle(callback(callbackFor(adapter, 'Deploy')));

    expect(respond).toHaveBeenCalledWith({
      rpcId: 'question-rpc-1',
      sessionId: 'session-1',
      answer: { answers: [{ id: 'deploy', selected: ['Deploy'] }] },
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

      await bridge.onQuestionRequested('question-retry', 'session-1', [{
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

    await bridge.onQuestionRequested('question-rpc-first', 'session-1', [{
      id: 'first',
      question: 'First decision?',
      options: [{ label: 'First answer' }],
    }], submitWith(respond, 'question-rpc-first'));
    await bridge.onQuestionRequested('question-rpc-second', 'session-1', [{
      id: 'second',
      question: 'Second decision?',
      options: [{ label: 'Second answer' }],
    }], submitWith(respond, 'question-rpc-second'));

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

    await bridge.onQuestionRequested('question-rpc-2', 'session-1', [{
      id: 'name',
      question: 'Release name?',
    }, {
      id: 'checks',
      question: 'Which checks?',
      multiSelect: true,
      options: [{ label: 'Tests' }, { label: 'Lint' }],
    }], submitWith(respond, 'question-rpc-2'));
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

    expect(respond).toHaveBeenCalledWith({
      rpcId: 'question-rpc-2',
      sessionId: 'session-1',
      answer: { answers: [
        { id: 'name', selected: [], custom: 'August release' },
        { id: 'checks', selected: ['Tests'] },
      ] },
    });
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
    await bridge.onQuestionRequested('question-utf16-limit', 'session-1', [{
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
    await bridge.onQuestionRequested('question-render-retry', 'session-1', [{
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
    await bridge.onQuestionRequested('question-toggle-rollback', 'session-1', [{
      id: 'checks',
      question: 'Select checks',
      multiSelect: true,
      options: [{ label: 'Tests' }],
    }], submitWith(respond, 'question-toggle-rollback'));
    const submit = latestCallbackFor(adapter, 'Submit');
    vi.spyOn(adapter, 'editText').mockRejectedValueOnce(new Error('temporary edit failure'));

    await bridge.handle(callback(latestCallbackFor(adapter, 'Tests')));
    await bridge.handle(callback(submit));

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      answer: { answers: [{ id: 'checks', selected: [] }] },
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
    await bridge.onQuestionRequested('question-resolution-race', 'session-1', [{
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
    await bridge.onQuestionRequested('question-before-progress', 'session-1', [{
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
    const callsBefore = sessions.resolveAgent.mock.calls.length;

    await bridge.handle(message('/unbind'));
    await bridge.handle(callback(modelButton.callbackData));

    expect(adapter.answers.at(-1)?.text).toContain('stale');
    expect(sessions.resolveAgent).toHaveBeenCalledTimes(callsBefore);
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
      content: [{ type: 'text', text: 'first try' }],
      mode: 'queue',
    }), expect.any(AbortSignal));
    send.mockRestore();
    await bridge.handle(message('second try'));

    expect(adapter.sent.filter((entry) => entry.text.startsWith('Exploring…'))).toHaveLength(1);
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
      content: [{ type: 'text', text: 'start immediately' }],
    }), expect.any(AbortSignal));
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
      return { accepted: true as const };
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

  it('updates private-chat progress by editing the placeholder message', async () => {
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
      const sentBeforePrompt = adapter.sent.length;

      await bridge.handle(message('stream with edits'));
      expect(adapter.sent).toHaveLength(sentBeforePrompt + 1);
      expect(adapter.sent.at(-1)?.options?.keyboard?.[0]?.[0]?.text).toBe('Cancel');

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

      expect(adapter.edits.at(-1)?.text).toContain('Final answer.');

      await bridge.onSessionEvent('session-1', {
        type: 'turn/end',
        seq: 2,
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'completed' } },
      } as unknown as SessionEvent);
      await vi.waitFor(() => expect(adapter.edits.at(-1)).toMatchObject({
        messageId: String(sentBeforePrompt + 1),
        text: 'Final answer.',
        keyboard: [],
      }));
      expect(adapter.sent).toHaveLength(sentBeforePrompt + 1);
      await bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
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
    expect(adapter.sent.some((entry) => entry.text.startsWith('Exploring…'))).toBe(true);
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
      const labels = [adapter.sent.at(-1)?.text.match(/^(.+?)…/)?.[1]];

      for (let index = 1; index <= 16; index += 1) {
        await vi.advanceTimersByTimeAsync(4_800);
        labels.push(adapter.edits.at(-1)?.text.match(/^(.+?)…/)?.[1]);
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

      // The status trail leads and the animated activity line stays at the tail.
      const statusAndActivity = adapter.edits.at(-1)?.text ?? '';
      expect(statusAndActivity.startsWith('✓ Searching for “progressText” in src')).toBe(true);
      expect(statusAndActivity).toMatch(/… [✦✧✶✳✢]$/);

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

      expect(adapter.sent.some((entry) => entry.text.startsWith('Thinking…'))).toBe(true);
      await vi.advanceTimersByTimeAsync(1_600);
      expect(adapter.edits.at(-1)?.text).toMatch(/^Thinking… ✧$/);
      expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'queue',
      }), expect.any(AbortSignal));

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

describe('voice message routing', () => {
  function voiceMessage(overrides: Partial<InboundVoiceMessage> = {}): InboundVoiceMessage {
    return { ...message(''), kind: 'voice', voice: { fileId: 'voice-1', durationSeconds: 10, sizeBytes: 100 }, ...overrides };
  }

  function setup() {
    const context = fakeContext();
    const adapter = Object.assign(new FakeAdapter(), {
      downloadVoice: vi.fn(async () => new Uint8Array([1, 2, 3])),
    });
    const requests: Array<{
      request: Parameters<VoiceTranscriber['transcribe']>[0];
      resolve: (text: string) => void;
      reject: (error: Error) => void;
    }> = [];
    const voice = {
      transcribe: vi.fn((request: Parameters<VoiceTranscriber['transcribe']>[0]) => new Promise<string>((resolve, reject) => {
        requests.push({ request, resolve, reject });
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
      dispose: vi.fn(async () => {}),
    };
    const bridge = new MessengerBridge(context.ctx, {
      allowedChatIds: ['100'], allowedUserIds: [], privateChatsOnly: true, voice,
    });
    bridge.registerAdapter(adapter);
    return { ...context, adapter, bridge, voice, requests };
  }

  it('does not initialize/download for unauthorized, unbound or oversized recordings', async () => {
    const { bridge, voice, adapter } = setup();
    try {
      await bridge.handle(voiceMessage({ chatId: '999' }));
      expect(adapter.sent).toHaveLength(0);
      await bridge.handle(voiceMessage());
      expect(adapter.sent.at(-1)?.text).toContain('No session');
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage({ voice: { fileId: 'v', durationSeconds: 301 } }));
      await bridge.handle(voiceMessage({ voice: { fileId: 'v', durationSeconds: 10, sizeBytes: 21 * 1024 * 1024 } }));
      expect(voice.transcribe).not.toHaveBeenCalled();
      expect(adapter.downloadVoice).not.toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });

  it('accepts zero-second metadata for nonempty sub-second voice recordings', async () => {
    const { bridge, requests, prompt, adapter } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage({ voice: { fileId: 'short-voice', durationSeconds: 0, sizeBytes: 3 } }));
      expect(requests).toHaveLength(1);
      await requests[0]!.request.loadAudio(requests[0]!.request.signal);
      expect(adapter.downloadVoice).toHaveBeenCalledOnce();
      requests[0]!.resolve('yes');
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    } finally { await bridge.dispose(); }
  });

  it('submits recognized slash text as content, never a messenger command', async () => {
    const { bridge, requests, prompt, adapter, voice } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage());
      await requests[0]!.request.loadAudio(requests[0]!.request.signal);
      expect(adapter.downloadVoice).toHaveBeenCalledOnce();
      requests[0]!.resolve('/new do not execute as a command');
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(prompt.mock.calls[0]).toEqual([expect.objectContaining({
        sessionId: 'session-1', content: [{ type: 'text', text: '/new do not execute as a command' }], mode: 'queue',
      }), expect.any(AbortSignal)]);
      expect(adapter.edits.some((edit) => edit.text.includes('Recognized:'))).toBe(true);
    } finally { await bridge.dispose(); }
    expect(voice.dispose).toHaveBeenCalledOnce();
  });

  it('keeps commands responsive and cancels only the operator\'s pending work', async () => {
    const { bridge, requests, sessions, prompt } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage());
      await bridge.handle(message('/status'));
      await bridge.handle(message('/voice_cancel', '999'));
      expect(requests[0]!.request.signal.aborted).toBe(false);
      await bridge.handle(message('/voice_cancel'));
      expect(requests[0]!.request.signal.aborted).toBe(true);
      expect(sessions.cancel).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });

  it('scopes the cancellation button to its originating operator', async () => {
    const { bridge, requests, adapter } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage());
      const data = callbackFor(adapter, 'Cancel transcription');
      await bridge.handle(callback(data, '200'));
      expect(requests[0]!.request.signal.aborted).toBe(false);
      await bridge.handle(callback(data));
      expect(requests[0]!.request.signal.aborted).toBe(true);
    } finally { await bridge.dispose(); }
  });

  it('does not retarget a transcript after unbind and rebind to the same session', async () => {
    const { bridge, requests, prompt, adapter } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage());
      await bridge.handle(message('/unbind'));
      await bridge.handle(message('/use session-1'));
      requests[0]!.resolve('old request');
      await vi.waitFor(() => expect(adapter.sent.some((sent) => sent.text.includes('Transcript not sent'))).toBe(true));
      expect(prompt).not.toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });

  it('rejects stale targets before downloading queued audio', async () => {
    const { bridge, requests, adapter } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage());
      await bridge.handle(message('/unbind'));
      await expect(requests[0]!.request.loadAudio(requests[0]!.request.signal)).rejects.toThrow('changed');
      expect(adapter.downloadVoice).not.toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });

  it('answers the captured question with recognized speech', async () => {
    const { bridge, requests, prompt, respond } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.onQuestionRequested('q-voice', 'session-1', [{ id: 'q1', question: 'Which branch?' }], submitWith(respond, 'q-voice'));
      await bridge.handle(voiceMessage());
      requests[0]!.resolve('feature voice');
      await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({
        answer: { answers: [{ id: 'q1', selected: [], custom: 'feature voice' }] },
      }));
      expect(prompt).not.toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });

  it('does not answer a different question that advanced during transcription', async () => {
    const { bridge, requests, prompt, respond, adapter } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.onQuestionRequested('q-voice', 'session-1', [
        { id: 'q1', question: 'Which branch?' }, { id: 'q2', question: 'Run tests?' },
      ], submitWith(respond, 'q-voice'));
      await bridge.handle(voiceMessage());
      await bridge.handle(message('main'));
      requests[0]!.resolve('feature voice');
      await vi.waitFor(() => expect(adapter.sent.some((sent) => sent.text.includes('Transcript not sent'))).toBe(true));
      expect(respond).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });

  it('does not turn an earlier prompt into an answer to a newly appearing question', async () => {
    const { bridge, requests, prompt, respond, adapter } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage());
      await bridge.onQuestionRequested('new-q', 'session-1', [{ id: 'q', question: 'Continue?' }], submitWith(respond, 'new-q'));
      requests[0]!.resolve('run tests');
      await vi.waitFor(() => expect(adapter.sent.some((sent) => sent.text.includes('Transcript not sent'))).toBe(true));
      expect(respond).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });

  it('preserves transcript submission order even if later transcription resolves first', async () => {
    const { bridge, requests, prompt } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage());
      await bridge.handle(voiceMessage());
      requests[1]!.resolve('second');
      await Promise.resolve();
      expect(prompt).not.toHaveBeenCalled();
      requests[0]!.resolve('first');
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      expect(prompt.mock.calls).toEqual([
        [expect.objectContaining({ content: [{ type: 'text', text: 'first' }] }), expect.any(AbortSignal)],
        [expect.objectContaining({ content: [{ type: 'text', text: 'second' }] }), expect.any(AbortSignal)],
      ]);
    } finally { await bridge.dispose(); }
  });

  it('cancels a resolved later voice without waiting for an earlier presentation tail', async () => {
    const { bridge, requests, prompt, adapter } = setup();
    await bridge.handle(message('/use session-1'));
    let releasePlaceholder!: (handle: MessengerMessageHandle) => void;
    const placeholder = new Promise<MessengerMessageHandle>((resolve) => { releasePlaceholder = resolve; });
    vi.spyOn(adapter, 'sendText').mockImplementationOnce(async () => placeholder);
    try {
      await bridge.handle(voiceMessage());
      await bridge.handle(voiceMessage());
      const cancelSecond = callbackFor(adapter, 'Cancel transcription');
      const secondStatusId = String(adapter.sent.length);
      requests[0]!.resolve('first transcript');
      requests[1]!.resolve('second transcript');
      // First waits for its placeholder; second waits for the first job's tail.
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(prompt).not.toHaveBeenCalled();
      await bridge.handle(callback(cancelSecond));
      expect(requests[0]!.request.signal.aborted).toBe(false);
      expect(requests[1]!.request.signal.aborted).toBe(true);
      await vi.waitFor(() => expect(adapter.edits.some((edit) => (
        edit.messageId === secondStatusId && edit.text.includes('Voice transcription cancelled')
      ))).toBe(true));
      expect(prompt).not.toHaveBeenCalled();
      releasePlaceholder({ chatId: '100', messageId: 'first-voice-placeholder' });
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(prompt.mock.calls[0]).toEqual([expect.objectContaining({
        content: [{ type: 'text', text: 'first transcript' }],
      }), expect.any(AbortSignal)]);
    } finally {
      releasePlaceholder({ chatId: '100', messageId: 'first-voice-placeholder' });
      await bridge.dispose();
    }
  });

  it('does not let a later voice overtake the first when the middle voice is cancelled', async () => {
    const { bridge, requests, prompt, adapter } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage());
      await bridge.handle(voiceMessage());
      const cancelMiddle = callbackFor(adapter, 'Cancel transcription');
      await bridge.handle(voiceMessage());
      await bridge.handle(callback(cancelMiddle));
      requests[2]!.resolve('third');
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      expect(prompt).not.toHaveBeenCalled();
      requests[0]!.resolve('first');
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      expect(prompt.mock.calls).toEqual([
        [expect.objectContaining({ content: [{ type: 'text', text: 'first' }] }), expect.any(AbortSignal)],
        [expect.objectContaining({ content: [{ type: 'text', text: 'third' }] }), expect.any(AbortSignal)],
      ]);
    } finally { await bridge.dispose(); }
  });

  it('bounds per-user pending work and shuts down all jobs on disposal', async () => {
    const { bridge, requests, voice, prompt, adapter } = setup();
    await bridge.handle(message('/use session-1'));
    for (let index = 0; index < 4; index += 1) await bridge.handle(voiceMessage());
    expect(voice.transcribe).toHaveBeenCalledTimes(3);
    expect(adapter.sent.at(-1)?.text).toContain('queue is full');
    await bridge.dispose();
    expect(requests.every(({ request }) => request.signal.aborted)).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not publish late voice status after disposal while the placeholder is pending', async () => {
    const { bridge, requests, prompt, adapter } = setup();
    await bridge.handle(message('/use session-1'));
    let releasePlaceholder!: (handle: MessengerMessageHandle) => void;
    const placeholder = new Promise<MessengerMessageHandle>((resolve) => { releasePlaceholder = resolve; });
    const send = vi.spyOn(adapter, 'sendText').mockReturnValue(placeholder);
    const edit = vi.spyOn(adapter, 'editText');
    try {
      await bridge.handle(voiceMessage());
      requests[0]!.resolve('ready before shutdown');
      // Drain the resolved transcription, preceding-job, and progress-edit awaits
      // so finish is suspended specifically on the unresolved placeholder.
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(send).toHaveBeenCalledOnce();
      expect(edit).not.toHaveBeenCalled();
      const stopping = bridge.dispose();
      releasePlaceholder({ chatId: '100', messageId: 'late-placeholder' });
      await stopping;
      expect(edit).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      releasePlaceholder({ chatId: '100', messageId: 'late-placeholder' });
      await bridge.dispose();
    }
  });

  it.each([true, false])('routes recognized content despite presentation failure (placeholder fails: %s)', async (failPlaceholder) => {
    const { bridge, requests, prompt, adapter } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      const send = vi.spyOn(adapter, 'sendText').mockRejectedValue(new Error('transport unavailable'));
      if (!failPlaceholder) send.mockResolvedValueOnce({ chatId: '100', messageId: 'placeholder' });
      const edit = vi.spyOn(adapter, 'editText').mockRejectedValue(new Error('message deleted'));
      await bridge.handle(voiceMessage());
      requests[0]!.resolve('submit even without Telegram status');
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(prompt.mock.calls[0]).toEqual([expect.objectContaining({
        sessionId: 'session-1', content: [{ type: 'text', text: 'submit even without Telegram status' }], mode: 'queue',
      }), expect.any(AbortSignal)]);
      expect(send.mock.calls.some(([, text]) => text.includes('Recognized:'))).toBe(true);
      if (!failPlaceholder) expect(edit).toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });

  it('preserves the full recognized status on adapters without replaceText', async () => {
    const { bridge, requests, prompt, adapter } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage());
      const transcript = 'speech '.repeat(600);
      requests[0]!.resolve(transcript);
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(adapter.sent.some((sent) => sent.text === `🎙 Recognized:\n\n${transcript.trim()}`)).toBe(true);
      expect(adapter.edits.some((edit) => edit.text === '🎙 Transcription complete.')).toBe(true);
    } finally { await bridge.dispose(); }
  });

  it('does not submit empty speech or failed recognition', async () => {
    const { bridge, requests, prompt, adapter } = setup();
    try {
      await bridge.handle(message('/use session-1'));
      await bridge.handle(voiceMessage());
      requests[0]!.resolve('   ');
      await vi.waitFor(() => expect(adapter.edits.some((edit) => edit.text.includes('No speech'))).toBe(true));
      await bridge.handle(voiceMessage());
      requests[1]!.reject(new Error('Local model unavailable'));
      await vi.waitFor(() => expect(adapter.edits.some((edit) => edit.text.includes('Local model unavailable'))).toBe(true));
      expect(prompt).not.toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });
});

describe('image message integration', () => {
  // A real 1x1 PNG; the bridge signature gate and controller base64 handoff use the same bytes.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  const image: MessengerImage = { bytes: png, mimeType: 'image/png' };
  const imagePart = { type: 'image', mediaType: 'image/png', data: png.toString('base64') };
  const attachmentBlock = (id = 'attachment-1') => ({
    type: 'image', attachment: { attachmentId: id, bytes: png.length, mediaType: 'image/png', width: 1, height: 1 },
  });
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  const photo = (text = '', overrides: Partial<InboundImageMessage> = {}): InboundImageMessage => ({
    ...message(text), kind: 'image', image: { fileId: 'photo-1', sizeBytes: png.length }, ...overrides,
  });
  const assistant = (content: unknown[], id = randomId(), surfaceOp = 'append'): SessionEvent => ({
    type: 'assistant/message', seq: 1, time: Date.now(), surfaceOp,
    data: { interrupted: false, message: { id, role: 'assistant', content } },
  } as unknown as SessionEvent);
  const finish = (bridge: MessengerBridge) => bridge.onSessionEvent('session-1', {
    type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } },
  } as unknown as SessionEvent);

  function setup(notificationStore?: NotificationStore) {
    const context = fakeContext();
    const attachment = vi.fn(async (_request: unknown) => ({ data: png.toString('base64'), mediaType: 'image/png' }));
    Object.assign(context.sessions, { attachment });
    const adapter = Object.assign(new FakeAdapter(), {
      downloadImage: vi.fn(async (_message: InboundImageMessage, _signal: AbortSignal): Promise<Uint8Array> => png),
      sendImage: vi.fn(async (chatId: string, _image: MessengerImage, _signal?: AbortSignal) => ({ chatId, messageId: randomId() })),
    });
    const bridge = new MessengerBridge(context.ctx, {
      allowedChatIds: ['100', '200', '300'], allowedUserIds: ['100', '200', '300', 'second-operator'], privateChatsOnly: false,
      ...(notificationStore === undefined ? {} : { notificationStore }),
    });
    bridge.registerAdapter(adapter);
    return { ...context, bridge, adapter, attachment };
  }

  it.each(['Describe this photo', '/new', '/unbind', '/stop'])('routes the authorized bound photo with literal caption %j', async (caption) => {
    const { bridge, adapter, prompt, sessions } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      const inbound = photo(caption);
      await bridge.handle(inbound);
      expect(adapter.downloadImage).toHaveBeenCalledWith(inbound, expect.any(AbortSignal));
      expect(prompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: caption }, imagePart],
      }), expect.any(AbortSignal));
      expect(sessions.create).not.toHaveBeenCalled();
      expect(sessions.cancel).not.toHaveBeenCalled();
      expect(bridge.canSendImage('session-1')).toBe(true);
    } finally { await bridge.dispose(); }
  });

  it('submits captionless photos as image-only prompts', async () => {
    const { bridge, prompt } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      await bridge.handle(photo());
      expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ content: [imagePart] }), expect.any(AbortSignal));
    } finally { await bridge.dispose(); }
  });

  it('never downloads unauthorized, unbound, or pending-question photos', async () => {
    const { bridge, adapter, prompt, respond } = setup();
    try {
      await bridge.handle(photo('/resume session-1', { chatId: '999' }));
      await bridge.handle(photo('Unauthorized sender', { senderId: 'intruder', chatKind: 'group' }));
      expect(adapter.sent).toEqual([]);
      await bridge.handle(photo('/resume session-1'));
      expect(adapter.sent.at(-1)?.text).toContain('No session selected');
      await bridge.handle(message('/resume session-1'));
      await bridge.onQuestionRequested('image-question', 'session-1', [{ id: 'q', question: 'Which branch?' }], submitWith(respond, 'image-question'));
      await bridge.handle(photo('main'));
      expect(adapter.sent.at(-1)?.text).toContain('pending question');
      expect(adapter.downloadImage).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });

  it.each([0, -1, 1.5, Number.NaN, 20 * 1024 * 1024 + 1])('rejects bad advertised image size %s before download', async (sizeBytes) => {
    const { bridge, adapter, prompt } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      await bridge.handle(photo('', { image: { fileId: 'photo-1', sizeBytes } }));
      expect(adapter.downloadImage).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(adapter.sent.at(-1)?.text).toContain('20 MiB');
    } finally { await bridge.dispose(); }
  });

  it.each(['empty', 'signature', 'oversized', 'transport'])('rejects %s download failures with sanitized errors', async (failure) => {
    const { bridge, adapter, prompt } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      if (failure === 'transport') adapter.downloadImage.mockRejectedValueOnce(new Error('SECRET token https://api.telegram.org/file/botSECRET/private.png'));
      else adapter.downloadImage.mockResolvedValueOnce(failure === 'empty' ? new Uint8Array() : failure === 'oversized' ? new Uint8Array(20 * 1024 * 1024 + 1) : Buffer.from('SECRET not an image'));
      await bridge.handle(photo());
      expect(prompt).not.toHaveBeenCalled();
      expect(adapter.sent.at(-1)?.text).toContain('Could not load the image');
      expect(JSON.stringify([adapter.sent, adapter.edits])).not.toContain('SECRET');
    } finally { await bridge.dispose(); }
  });

  it('disposal aborts and interrupts a download even when the adapter ignores cancellation', async () => {
    const { bridge, adapter, prompt } = setup();
    const entered = deferred<AbortSignal>();
    const download = deferred<Uint8Array>();
    adapter.downloadImage.mockImplementationOnce(async (_message, signal) => {
      entered.resolve(signal);
      return download.promise;
    });
    try {
      await bridge.handle(message('/resume session-1'));
      const pending = bridge.handle(photo('Do not submit after disposal'));
      const signal = await entered.promise;
      const sentBefore = adapter.sent.length;
      await bridge.dispose();
      await pending;
      expect(signal.aborted).toBe(true);
      expect(prompt).not.toHaveBeenCalled();
      expect(adapter.sent).toHaveLength(sentBefore);
    } finally { download.resolve(png); await bridge.dispose(); }
  });

  it('surfaces the controller image-support rejection instead of claiming prompt success', async () => {
    const { bridge, adapter, prompt } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      prompt.mockRejectedValueOnce(new Error('Selected model does not support image input'));
      await bridge.handle(photo());
      expect(prompt).toHaveBeenCalledOnce();
      expect([...adapter.sent, ...adapter.edits].some(({ text }) => text.includes('Selected model does not support image input'))).toBe(true);
    } finally { await bridge.dispose(); }
  });

  it.each([false, true])('resolves native append attachments in the source session and preserves text (active=%s)', async (active) => {
    const { bridge, adapter, attachment } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      if (active) await bridge.handle(message('Show me'));
      adapter.sent.length = 0;
      const event = assistant([attachmentBlock(), { type: 'text', text: 'The complete final reply.' }], 'native-image');
      await bridge.onSessionEvent('session-1', event);
      await bridge.onSessionEvent('session-1', event);
      expect(attachment).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', attachmentId: 'attachment-1' });
      expect(adapter.sendImage).toHaveBeenCalledExactlyOnceWith('100', image, expect.any(AbortSignal));
      if (active) await finish(bridge);
      await vi.waitFor(() => expect([...adapter.sent, ...adapter.edits].some(({ text }) => text.includes('The complete final reply.'))).toBe(true));
    } finally { await bridge.dispose(); }
  });

  it('does not export tool results, chunks, history/nonappend messages, or Markdown paths', async () => {
    const { bridge, adapter, attachment } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      const events = [
        assistant([attachmentBlock()], randomId(), 'replace'),
        assistant([attachmentBlock()], randomId(), 'none'),
        { ...assistant([attachmentBlock()]), surfaceOp: undefined },
        { type: 'tool/result', seq: 2, time: Date.now(), data: { callId: 'call', result: [attachmentBlock()] } },
        { type: 'assistant/chunk', seq: 3, time: Date.now(), data: { chunk: attachmentBlock() } },
        assistant([{ type: 'text', text: '![image](/private/output.png)' }]),
      ];
      for (const event of events) await bridge.onSessionEvent('session-1', event as unknown as SessionEvent);
      expect(attachment).not.toHaveBeenCalled();
      expect(adapter.sendImage).not.toHaveBeenCalled();
    } finally { await bridge.dispose(); }
  });

  it.each(['resolve', 'upload'])('preserves final text after an image %s failure and does not retry duplicate events', async (failure) => {
    const { bridge, adapter, attachment } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      await bridge.handle(message('Show me'));
      if (failure === 'resolve') attachment.mockRejectedValueOnce(new Error('SECRET attachment storage path'));
      else adapter.sendImage.mockRejectedValueOnce(new Error('SECRET Telegram token'));
      const event = assistant([attachmentBlock(), { type: 'text', text: 'Final text still arrives.' }]);
      await bridge.onSessionEvent('session-1', event);
      await bridge.onSessionEvent('session-1', event);
      await finish(bridge);
      expect(attachment).toHaveBeenCalledOnce();
      expect(adapter.sendImage).toHaveBeenCalledTimes(failure === 'resolve' ? 0 : 1);
      expect(adapter.sent.some(({ text }) => /Could not .*image/.test(text))).toBe(true);
      await vi.waitFor(() => expect(adapter.edits.at(-1)?.text).toContain('Final text still arrives.'));
      expect(JSON.stringify([adapter.sent, adapter.edits])).not.toContain('SECRET');
    } finally { await bridge.dispose(); }
  });

  it('rejects oversized native attachment metadata before resolver IO while preserving final text', async () => {
    const { bridge, adapter, attachment } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      const block = attachmentBlock();
      block.attachment.bytes = 20 * 1024 * 1024 + 1;
      await bridge.onSessionEvent('session-1', assistant([block, { type: 'text', text: 'Text without oversized image.' }]));
      expect(attachment).not.toHaveBeenCalled();
      expect(adapter.sendImage).not.toHaveBeenCalled();
      expect(adapter.sent.at(-1)?.text).toBe('Text without oversized image.');
    } finally { await bridge.dispose(); }
  });

  it('disposal interrupts native attachment resolution without late images, errors, or final text', async () => {
    const { bridge, adapter, attachment } = setup();
    const entered = deferred<void>();
    const resolved = deferred<{ data: string; mediaType: string }>();
    attachment.mockImplementationOnce(async () => { entered.resolve(); return resolved.promise; });
    try {
      await bridge.handle(message('/resume session-1'));
      adapter.sent.length = 0;
      const pending = bridge.onSessionEvent('session-1', assistant([attachmentBlock(), { type: 'text', text: 'Must not arrive after disposal.' }]));
      await entered.promise;
      await bridge.dispose();
      await pending;
      expect(adapter.sendImage).not.toHaveBeenCalled();
      expect(adapter.sent).toEqual([]);
      expect(adapter.edits).toEqual([]);
    } finally { resolved.resolve({ data: png.toString('base64'), mediaType: 'image/png' }); await bridge.dispose(); }
  });

  it.each(['add-chat', 'rebind'])('fences the entire native image batch when the first resolver causes %s', async (change) => {
    const { bridge, adapter, attachment } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      attachment.mockImplementationOnce(async () => {
        if (change === 'add-chat') await bridge.handle(message('/resume session-1', '200'));
        else {
          await bridge.handle(message('/unbind'));
          await bridge.handle(message('/resume session-1'));
        }
        return { data: png.toString('base64'), mediaType: 'image/png' };
      });
      await bridge.onSessionEvent('session-1', assistant([attachmentBlock('first'), attachmentBlock('second')]));
      expect(attachment).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', attachmentId: 'first' });
      expect(adapter.sendImage).not.toHaveBeenCalled();
      expect(bridge.canSendImage('session-1')).toBe(true);
    } finally { await bridge.dispose(); }
  });

  it('drains an already-submitted image prompt during disposal without duplicate submission', async () => {
    const { bridge, prompt } = setup();
    const entered = deferred<void>();
    const accepted = deferred<{ accepted: true }>();
    prompt.mockImplementationOnce(async () => { entered.resolve(); return accepted.promise; });
    let stopping: Promise<void> | undefined;
    try {
      await bridge.handle(message('/resume session-1'));
      const handling = bridge.handle(photo('Already submitted'));
      await entered.promise;
      let disposed = false;
      stopping = bridge.dispose().then(() => { disposed = true; });
      await Promise.resolve();
      expect(disposed).toBe(false);
      expect(prompt).toHaveBeenCalledOnce();
      accepted.resolve({ accepted: true });
      await handling;
      await stopping;
      expect(disposed).toBe(true);
      expect(prompt).toHaveBeenCalledOnce();
    } finally { accepted.resolve({ accepted: true }); await stopping; await bridge.dispose(); }
  });

  it('caps native response images at ten while retaining the text', async () => {
    const { bridge, adapter, attachment } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      await bridge.onSessionEvent('session-1', assistant([
        ...Array.from({ length: 12 }, (_, i) => attachmentBlock(`attachment-${i}`)),
        { type: 'text', text: 'Twelve images were requested.' },
      ]));
      expect(attachment).toHaveBeenCalledTimes(10);
      expect(adapter.sendImage).toHaveBeenCalledTimes(10);
      expect(adapter.sent.some(({ text }) => text.includes('limit of 10 images'))).toBe(true);
      expect(adapter.sent.at(-1)?.text).toBe('Twelve images were requested.');
    } finally { await bridge.dispose(); }
  });

  it.each([false, true])('delivers an image-only final response without inventing text (active=%s)', async (active) => {
    const { bridge, adapter } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      if (active) await bridge.handle(message('Draw this'));
      adapter.sent.length = 0;
      await bridge.onSessionEvent('session-1', assistant([attachmentBlock()]));
      await finish(bridge);
      expect(adapter.sendImage).toHaveBeenCalledOnce();
      if (active) await vi.waitFor(() => expect(adapter.edits.at(-1)?.text).toContain('Finished.'));
      else expect(adapter.sent).toEqual([]);
    } finally { await bridge.dispose(); }
  });

  it('exports only to current session bindings, deduplicates shared chats, and ignores notification subscribers', async () => {
    const store = new NotificationStore({ subscriptions: [], links: [] }, vi.fn(async () => {}));
    const { bridge, adapter, sessions } = setup(store);
    try {
      const original = (await sessions.list()).items[0]!;
      sessions.list.mockResolvedValue({ items: [original, { ...original, sessionId: 'session-2' }] });
      await bridge.handle(message('/resume session-1'));
      await bridge.handle({ ...message('/resume session-1'), senderId: 'second-operator', chatKind: 'group' });
      await bridge.handle(message('/resume session-2', '200'));
      await bridge.handle(message('/notifications on', '300'));
      expect(await bridge.sendImage('session-1', image)).toEqual({ sent: 1, failed: 0, skipped: 0 });
      expect(adapter.sendImage).toHaveBeenCalledExactlyOnceWith('100', image, expect.any(AbortSignal));
      await expect(bridge.sendImage('unbound-session', image)).rejects.toThrow('No image-capable messenger chat');
      expect(adapter.sendImage).toHaveBeenCalledOnce();
      await bridge.handle(message('/unbind'));
      expect(bridge.canSendImage('session-1')).toBe(true); // The second operator really was bound.
      await bridge.handle({ ...message('/unbind'), senderId: 'second-operator', chatKind: 'group' });
      expect(bridge.canSendImage('session-1')).toBe(false);
    } finally { await bridge.dispose(); }
  });

  it.each(['cancel', 'rebind', 'dispose'])('skips queued image exports after %s', async (action) => {
    const { bridge, adapter } = setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    try {
      await bridge.handle(message('/resume session-1'));
      adapter.sendImage.mockImplementationOnce(async (chatId) => {
        entered.resolve();
        await release.promise;
        return { chatId, messageId: 'held-image' };
      });
      const first = bridge.sendImage('session-1', image);
      await entered.promise;
      const controller = new AbortController();
      const second = bridge.sendImage('session-1', image, controller.signal);
      if (action === 'cancel') controller.abort();
      if (action === 'rebind') {
        await bridge.handle(message('/unbind'));
        await bridge.handle(message('/resume session-1'));
      }
      const stopping = action === 'dispose' ? bridge.dispose() : undefined;
      release.resolve();
      await first;
      expect(await second).toEqual({ sent: 0, failed: 0, skipped: 1 });
      expect(adapter.sendImage).toHaveBeenCalledOnce();
      await stopping;
    } finally { release.resolve(); await bridge.dispose(); }
  });

  it('skips already-cancelled exports and reports partial failures without exposing transport errors', async () => {
    const { bridge, adapter } = setup();
    try {
      await bridge.handle(message('/resume session-1'));
      await bridge.handle(message('/resume session-1', '200'));
      expect(await bridge.sendImage('session-1', image, AbortSignal.abort())).toEqual({ sent: 0, failed: 0, skipped: 2 });
      expect(adapter.sendImage).not.toHaveBeenCalled();
      adapter.sendImage.mockRejectedValueOnce(new Error('SECRET Telegram token'));
      expect(await bridge.sendImage('session-1', image)).toEqual({ sent: 1, failed: 1, skipped: 0 });
      expect(adapter.sendImage).toHaveBeenCalledTimes(2);
      expect(JSON.stringify([adapter.sent, adapter.edits])).not.toContain('SECRET');
    } finally { await bridge.dispose(); }
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
