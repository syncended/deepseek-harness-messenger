import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api';
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { DshControl, sessionTitle, visibleAssistantText } from './control.js';
import { splitTelegramText } from './telegram.js';
import type {
  InboundCallbackInteraction,
  InboundMessengerMessage,
  InboundTextMessage,
  MessengerAdapter,
  MessengerInlineKeyboard,
  MessengerMessageHandle,
  ParsedCommand,
} from './types.js';

const CALLBACK_TTL_MS = 10 * 60_000;
const SESSION_PAGE_SIZE = 7;
const MAX_MODEL_BUTTONS = 24;
const PROGRESS_EDIT_INTERVAL_MS = 750;
const TYPING_REFRESH_MS = 4_000;
const TELEGRAM_PROGRESS_LIMIT = 4_096;

export type BridgeContext = {
  readonly agents: AgentRegistry;
  readonly apiProxy: ApiProxy;
  readonly permissionPresets: PermissionPresetService;
  readonly logger: Context['logger'];
};

export interface MessengerBridgeOptions {
  readonly allowedChatIds: readonly string[];
  readonly allowedUserIds: readonly string[];
  readonly privateChatsOnly: boolean;
}

type CallbackAction =
  | { readonly kind: 'menu' }
  | { readonly kind: 'sessions'; readonly page: number }
  | { readonly kind: 'bind'; readonly sessionId: string }
  | { readonly kind: 'new' }
  | { readonly kind: 'models'; readonly sessionId: string }
  | { readonly kind: 'select-model'; readonly sessionId: string; readonly provider: string; readonly model: string }
  | { readonly kind: 'reasoning'; readonly sessionId: string }
  | { readonly kind: 'select-reasoning'; readonly sessionId: string; readonly effort?: string }
  | { readonly kind: 'permission'; readonly sessionId: string }
  | { readonly kind: 'select-permission'; readonly sessionId: string; readonly preset: string }
  | { readonly kind: 'confirm-permission'; readonly sessionId: string; readonly preset: string }
  | { readonly kind: 'context'; readonly sessionId: string }
  | { readonly kind: 'cancel'; readonly sessionId: string };

interface CallbackRecord {
  readonly transport: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly bindingRevision: number;
  readonly expiresAt: number;
  readonly action: CallbackAction;
}

interface ProgressState {
  readonly key: string;
  readonly adapter: MessengerAdapter;
  readonly chatId: string;
  readonly sessionId: string;
  handle?: MessengerMessageHandle;
  ready: Promise<void>;
  text: string;
  readonly status: string[];
  readonly toolNames: Map<string, string>;
  editTimer: ReturnType<typeof setTimeout> | undefined;
  typingTimer: ReturnType<typeof setInterval> | undefined;
  lastRendered?: string;
  turnEnded: boolean;
}

export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const separator = trimmed.search(/\s/);
  const rawName = (separator < 0 ? trimmed : trimmed.slice(0, separator)).slice(1);
  const name = rawName.toLowerCase();
  if (name.length === 0) return undefined;
  return {
    name,
    argument: separator < 0 ? '' : trimmed.slice(separator).trim(),
  };
}

function bindingKey(transport: string, chatId: string): string {
  return `${transport}:${chatId}`;
}

function shortId(sessionId: string): string {
  return sessionId.length <= 10 ? sessionId : `…${sessionId.slice(-8)}`;
}

function compactNumber(value: number | undefined): string {
  if (value === undefined) return '—';
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function contextLabel(projected: number | undefined, window: number | undefined): string {
  if (projected === undefined && window === undefined) return 'not measured';
  if (window === undefined) return `${compactNumber(projected)} tokens`;
  const percentage = projected === undefined ? undefined : Math.round((projected / window) * 100);
  return `${compactNumber(projected)}/${compactNumber(window)}${percentage === undefined ? '' : ` (${percentage}%)`}`;
}

function helpText(): string {
  return [
    'DeepSeek Harness messenger controls',
    '',
    '/menu — open the control panel',
    '/sessions or /resume — choose a persisted session',
    '/new — create and bind a new session',
    '/status — show the current session dashboard',
    '/model — choose provider and model',
    '/reasoning — choose reasoning effort',
    '/permission — choose the DSH permission preset',
    '/context — show context and token usage',
    '/steer <text> — steer the active turn',
    '/cancel — cancel the active turn',
    '/unbind — remove the binding',
    '/help — show this help',
    '',
    'Any other text is sent to the bound DSH session.',
  ].join('\n');
}

function actionSessionId(action: CallbackAction): string | undefined {
  switch (action.kind) {
    case 'models':
    case 'select-model':
    case 'reasoning':
    case 'select-reasoning':
    case 'permission':
    case 'select-permission':
    case 'confirm-permission':
    case 'context':
    case 'cancel':
      return action.sessionId;
    default:
      return undefined;
  }
}

function callbackKeyboard(
  rows: readonly (readonly { text: string; callbackData: string }[])[],
): MessengerInlineKeyboard {
  return rows;
}

function safeToolName(name: string): string {
  const compact = name.replace(/[^A-Za-z0-9_./:-]/g, ' ').replace(/\s+/g, ' ').trim();
  return (compact || 'tool').slice(0, 80);
}

function progressText(state: ProgressState): string {
  const body = state.text.trim();
  const status = state.status.slice(-4).join('\n');
  const rendered = [body || (state.turnEnded ? 'Finished.' : 'Deep diving…'), status]
    .filter(Boolean)
    .join('\n\n');
  const characters = Array.from(rendered);
  if (characters.length <= TELEGRAM_PROGRESS_LIMIT) return rendered;
  return `…\n${characters.slice(-(TELEGRAM_PROGRESS_LIMIT - 2)).join('')}`;
}

export class MessengerBridge {
  private readonly allowedChatIds: ReadonlySet<string>;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly privateChatsOnly: boolean;
  private readonly bindings = new Map<string, string>();
  private readonly bindingOperators = new Map<string, string>();
  private readonly bindingRevisions = new Map<string, number>();
  private readonly adapters = new Map<string, MessengerAdapter>();
  private readonly outboundQueues = new Map<string, Promise<unknown>>();
  private readonly actionQueues = new Map<string, Promise<unknown>>();
  private readonly callbacks = new Map<string, CallbackRecord>();
  private readonly progress = new Map<string, ProgressState>();
  private readonly control: DshControl;
  private disposed = false;

  constructor(
    private readonly ctx: BridgeContext,
    options: MessengerBridgeOptions,
  ) {
    this.allowedChatIds = new Set(options.allowedChatIds);
    this.allowedUserIds = new Set(options.allowedUserIds);
    this.privateChatsOnly = options.privateChatsOnly;
    this.control = new DshControl(ctx);
  }

  registerAdapter(adapter: MessengerAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Messenger adapter "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  async handle(message: InboundMessengerMessage): Promise<void> {
    if (this.disposed) return;
    const adapter = this.adapters.get(message.transport);
    if (adapter === undefined) throw new Error(`Unknown messenger adapter "${message.transport}"`);

    if (!this.authorized(message)) {
      this.ctx.logger.warn(
        'messenger: ignored unauthorized %s chat %s from user %s',
        message.transport,
        message.chatId,
        message.senderId,
      );
      if (message.kind === 'callback_query') {
        await adapter.answerCallback(message.callbackQueryId, 'Not authorized.', true);
      }
      return;
    }

    if (message.kind === 'callback_query') {
      await this.handleCallback(adapter, message);
      return;
    }

    await this.enqueueAction(
      bindingKey(adapter.id, message.chatId),
      () => this.handleTextMessage(adapter, message),
    );
  }

  private async handleTextMessage(
    adapter: MessengerAdapter,
    message: InboundTextMessage,
  ): Promise<void> {
    const command = parseCommand(message.text);
    if (command !== undefined) {
      await this.handleCommand(adapter, message.chatId, message.senderId, command);
      return;
    }

    const sessionId = this.bindings.get(bindingKey(message.transport, message.chatId));
    if (sessionId === undefined) {
      await adapter.sendText(
        message.chatId,
        'No session selected. Use /resume to choose one or /new to create one.',
        { keyboard: this.mainKeyboard(adapter.id, message.chatId, message.senderId) },
      );
      return;
    }

    await this.beginProgress(adapter, message.chatId, message.senderId, sessionId);
    try {
      await this.control.prompt(sessionId, message.text, 'queue');
    } catch (error) {
      await this.failProgress(adapter, message.chatId, sessionId, error);
    }
  }

  async onSessionEvent(sessionId: string, event: SessionEvent): Promise<void> {
    if (this.disposed) return;
    const states = this.progressStates(sessionId);
    if (states.length === 0 && this.hasBindings(sessionId) && (
      event.type === 'turn/start'
      || event.type === 'assistant/chunk'
      || event.type === 'tool/call'
    )) {
      await this.beginProgressForBindings(sessionId);
    }

    const active = this.progressStates(sessionId);
    if (active.length === 0) {
      const finalText = visibleAssistantText(event);
      if (finalText !== undefined) await this.sendToBindings(sessionId, finalText);
      return;
    }

    if (event.type === 'assistant/chunk') {
      if (event.data.chunk.type === 'text-delta') {
        for (const state of active) state.text += event.data.chunk.text;
      } else if (event.data.chunk.type === 'reasoning-delta') {
        for (const state of active) {
          if (!state.status.includes('💭 Reasoning…')) state.status.push('💭 Reasoning…');
        }
      }
      this.scheduleProgressEdits(active);
      return;
    }

    if (event.type === 'assistant/message') {
      const text = visibleAssistantText(event);
      if (text !== undefined) {
        for (const state of active) state.text = text;
      }
      if (event.data.interrupted) {
        for (const state of active) state.status.push('⏹ Interrupted');
      }
      this.scheduleProgressEdits(active);
      return;
    }

    if (event.type === 'tool/call') {
      const name = safeToolName(event.data.name);
      for (const state of active) {
        state.toolNames.set(String(event.data.callId), name);
        state.status.push(`🔧 ${name}`);
      }
      this.scheduleProgressEdits(active);
      return;
    }

    if (event.type === 'tool/result') {
      const callId = String(event.data.message.source.callId);
      for (const state of active) {
        const name = state.toolNames.get(callId) ?? 'tool';
        state.status.push(`${event.data.error === undefined ? '✅' : '❌'} ${name}`);
      }
      this.scheduleProgressEdits(active);
      return;
    }

    if (event.type === 'todo/write') {
      const completed = event.data.todos.filter((todo) => todo.status === 'completed').length;
      for (const state of active) state.status.push(`📋 Checklist ${completed}/${event.data.todos.length}`);
      this.scheduleProgressEdits(active);
      return;
    }

    if (event.type === 'turn/end') {
      for (const state of active) {
        state.turnEnded = true;
        if (event.data.reason.kind === 'aborted') state.status.push('⏹ Cancelled');
        if (event.data.reason.kind === 'error') state.status.push('❌ Turn failed');
        if (event.data.reason.kind === 'blocked') state.status.push('⏸ Blocked');
        if (event.data.reason.kind === 'max-tokens') state.status.push('⚠️ Output limit reached');
      }
      await Promise.all(active.map((state) => this.finalizeProgress(state)));
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.progress.values()) this.stopProgressTimers(state);
    this.progress.clear();
    this.callbacks.clear();
    await Promise.allSettled([
      ...this.actionQueues.values(),
      ...this.outboundQueues.values(),
    ]);
  }

  private authorized(message: InboundMessengerMessage): boolean {
    if (!this.allowedChatIds.has(message.chatId)) return false;
    if (message.chatKind === 'private') return true;
    return !this.privateChatsOnly && this.allowedUserIds.has(message.senderId);
  }

  private async handleCallback(
    adapter: MessengerAdapter,
    message: InboundCallbackInteraction,
  ): Promise<void> {
    const token = message.data.startsWith('m:') ? message.data.slice(2) : '';
    const record = this.callbacks.get(token);
    if (record === undefined || record.expiresAt < Date.now()) {
      if (record !== undefined) this.callbacks.delete(token);
      await adapter.answerCallback(message.callbackQueryId, 'This control expired. Open /menu again.', true);
      return;
    }
    if (
      record.transport !== adapter.id
      || record.chatId !== message.chatId
      || record.senderId !== message.senderId
    ) {
      await adapter.answerCallback(message.callbackQueryId, 'This control belongs to another operator.', true);
      return;
    }
    const key = bindingKey(adapter.id, message.chatId);
    const target = actionSessionId(record.action);
    if (target !== undefined && (
      this.bindings.get(key) !== target
      || (this.bindingRevisions.get(key) ?? 0) !== record.bindingRevision
    )) {
      this.callbacks.delete(token);
      await adapter.answerCallback(message.callbackQueryId, 'This control is stale. Open /menu again.', true);
      return;
    }

    this.callbacks.delete(token);
    try {
      await adapter.answerCallback(message.callbackQueryId);
    } catch (error) {
      this.ctx.logger.warn('messenger: failed to answer claimed callback: %o', error);
    }
    await this.enqueueAction(bindingKey(adapter.id, message.chatId), async () => {
      try {
        await this.runAction(
          adapter,
          message.chatId,
          message.senderId,
          record.action,
          record.bindingRevision,
        );
      } catch (error) {
        await adapter.sendText(
          message.chatId,
          `Could not complete that action: ${this.errorMessage(error)}`,
        );
      }
    });
  }

  private async runAction(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    action: CallbackAction,
    expectedBindingRevision: number,
  ): Promise<void> {
    const target = actionSessionId(action);
    const key = bindingKey(adapter.id, chatId);
    if (target !== undefined && (
      this.bindings.get(key) !== target
      || (this.bindingRevisions.get(key) ?? 0) !== expectedBindingRevision
    )) {
      throw new Error('This control is stale because the selected session changed.');
    }
    switch (action.kind) {
      case 'menu':
        await this.showDashboard(adapter, chatId, senderId);
        return;
      case 'sessions':
        await this.showSessions(adapter, chatId, senderId, action.page);
        return;
      case 'bind':
        await this.bindSession(adapter, chatId, senderId, action.sessionId);
        return;
      case 'new':
        await this.createSession(adapter, chatId, senderId);
        return;
      case 'models':
        await this.showModels(adapter, chatId, senderId, action.sessionId);
        return;
      case 'select-model':
        await this.selectModel(adapter, chatId, senderId, action.sessionId, action.provider, action.model);
        return;
      case 'reasoning':
        await this.showReasoning(adapter, chatId, senderId, action.sessionId);
        return;
      case 'select-reasoning':
        await this.selectReasoning(adapter, chatId, senderId, action.sessionId, action.effort);
        return;
      case 'permission':
        await this.showPermissions(adapter, chatId, senderId, action.sessionId);
        return;
      case 'select-permission':
        if (action.preset === 'danger-full-access') {
          await adapter.sendText(
            chatId,
            'Danger full access disables the workspace sandbox and approval prompts for this session. Continue?',
            { keyboard: callbackKeyboard([[
              this.button(adapter.id, chatId, senderId, 'Enable danger full access', {
                kind: 'confirm-permission',
                sessionId: action.sessionId,
                preset: action.preset,
              }),
              this.button(adapter.id, chatId, senderId, 'Cancel', { kind: 'menu' }),
            ]]) },
          );
          return;
        }
        await this.setPermission(adapter, chatId, senderId, action.sessionId, action.preset);
        return;
      case 'confirm-permission':
        await this.setPermission(adapter, chatId, senderId, action.sessionId, action.preset);
        return;
      case 'context':
        await this.showContext(adapter, chatId, senderId, action.sessionId);
        return;
      case 'cancel':
        await this.cancel(adapter, chatId, senderId, action.sessionId);
    }
  }

  private async handleCommand(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    command: ParsedCommand,
  ): Promise<void> {
    try {
      switch (command.name) {
        case 'start':
        case 'menu':
        case 'status':
          await this.showDashboard(adapter, chatId, senderId);
          return;
        case 'help':
          await adapter.sendText(chatId, helpText(), {
            keyboard: this.mainKeyboard(adapter.id, chatId, senderId),
          });
          return;
        case 'sessions':
          await this.showSessions(adapter, chatId, senderId, 0);
          return;
        case 'resume':
        case 'use':
          if (command.argument) {
            await this.bindSession(adapter, chatId, senderId, command.argument);
          } else {
            await this.showSessions(adapter, chatId, senderId, 0);
          }
          return;
        case 'new':
          await this.createSession(adapter, chatId, senderId);
          return;
        case 'model':
          await this.showModels(adapter, chatId, senderId);
          return;
        case 'reasoning':
          await this.showReasoning(adapter, chatId, senderId);
          return;
        case 'permission':
          await this.showPermissions(adapter, chatId, senderId);
          return;
        case 'context':
          await this.showContext(adapter, chatId, senderId);
          return;
        case 'unbind': {
          const key = bindingKey(adapter.id, chatId);
          this.bindings.delete(key);
          this.bindingOperators.delete(key);
          this.bindingRevisions.set(key, (this.bindingRevisions.get(key) ?? 0) + 1);
          await adapter.sendText(chatId, 'Binding removed.', {
            keyboard: this.mainKeyboard(adapter.id, chatId, senderId),
          });
          return;
        }
        case 'cancel':
          await this.cancel(adapter, chatId, senderId);
          return;
        case 'steer': {
          const sessionId = this.binding(adapter.id, chatId);
          if (command.argument.length === 0) {
            await adapter.sendText(chatId, 'Usage: /steer <text>');
            return;
          }
          await this.control.prompt(sessionId, command.argument, 'steer');
          await adapter.sendText(chatId, `Steering queued for ${shortId(sessionId)}.`);
          return;
        }
        default:
          await adapter.sendText(chatId, `Unknown command /${command.name}. Use /help.`);
      }
    } catch (error) {
      await adapter.sendText(chatId, `Could not complete that action: ${this.errorMessage(error)}`);
    }
  }

  private async showSessions(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    requestedPage: number,
  ): Promise<void> {
    const sessions = await this.control.listSessions();
    if (sessions.length === 0) {
      await adapter.sendText(chatId, 'No sessions yet. Create the first one.', {
        keyboard: callbackKeyboard([[
          this.button(adapter.id, chatId, senderId, 'New session', { kind: 'new' }),
        ]]),
      });
      return;
    }
    const pages = Math.ceil(sessions.length / SESSION_PAGE_SIZE);
    const page = Math.max(0, Math.min(requestedPage, pages - 1));
    const selected = this.bindings.get(bindingKey(adapter.id, chatId));
    const rows = sessions
      .slice(page * SESSION_PAGE_SIZE, (page + 1) * SESSION_PAGE_SIZE)
      .map((session) => [this.button(
        adapter.id,
        chatId,
        senderId,
        `${String(session.sessionId) === selected ? '✓' : session.running ? '🟢' : '⚪'} ${sessionTitle(session).slice(0, 40)} · ${shortId(String(session.sessionId))}`,
        { kind: 'bind', sessionId: String(session.sessionId) },
      )]);
    const navigation: { text: string; callbackData: string }[] = [];
    if (page > 0) navigation.push(this.button(adapter.id, chatId, senderId, '‹ Previous', { kind: 'sessions', page: page - 1 }));
    if (page + 1 < pages) navigation.push(this.button(adapter.id, chatId, senderId, 'Next ›', { kind: 'sessions', page: page + 1 }));
    if (navigation.length > 0) rows.push(navigation);
    rows.push([
      this.button(adapter.id, chatId, senderId, 'New session', { kind: 'new' }),
      this.button(adapter.id, chatId, senderId, 'Menu', { kind: 'menu' }),
    ]);
    await adapter.sendText(chatId, `Choose a session · page ${page + 1}/${pages}`, {
      keyboard: callbackKeyboard(rows),
    });
  }

  private async bindSession(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId: string,
  ): Promise<void> {
    const sessions = await this.control.listSessions();
    if (!sessions.some((session) => String(session.sessionId) === sessionId)) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    // Reading the model directory uses the canonical resume path for dormant sessions.
    await this.control.models(sessionId);
    const key = bindingKey(adapter.id, chatId);
    this.bindings.set(key, sessionId);
    this.bindingOperators.set(key, senderId);
    this.bindingRevisions.set(key, (this.bindingRevisions.get(key) ?? 0) + 1);
    await this.showDashboard(adapter, chatId, senderId);
  }

  private async createSession(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
  ): Promise<void> {
    await adapter.sendTyping(chatId);
    const sessionId = await this.control.createSession();
    const key = bindingKey(adapter.id, chatId);
    this.bindings.set(key, sessionId);
    this.bindingOperators.set(key, senderId);
    this.bindingRevisions.set(key, (this.bindingRevisions.get(key) ?? 0) + 1);
    await adapter.sendText(chatId, `Created ${shortId(sessionId)}.`);
    await this.showDashboard(adapter, chatId, senderId);
  }

  private async showDashboard(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
  ): Promise<void> {
    const sessionId = this.bindings.get(bindingKey(adapter.id, chatId));
    if (sessionId === undefined) {
      await adapter.sendText(
        chatId,
        'DeepSeek Harness\n\nNo session selected. Resume one or create a new session.',
        { keyboard: this.mainKeyboard(adapter.id, chatId, senderId) },
      );
      return;
    }
    const snapshot = await this.control.snapshot(sessionId);
    const state = this.control.status(sessionId);
    const selection = snapshot.model.current;
    const text = [
      `${state === 'running' ? '🟢' : state === 'idle' ? '⚪' : '💤'} ${sessionTitle(snapshot.summary)} · ${shortId(sessionId)}`,
      `State: ${state}`,
      `Model: ${selection.provider}/${selection.model}`,
      `Reasoning: ${selection.reasoningEffort ?? 'default'}`,
      `Permission: ${snapshot.permission.current}`,
      `Context: ${contextLabel(snapshot.context.projectedTokens ?? snapshot.context.pressureTokens, snapshot.context.contextWindow)}`,
      ...(snapshot.summary.cwd ? [`Workspace: ${snapshot.summary.cwd}`] : []),
    ].join('\n');
    const rows = [
      [
        this.button(adapter.id, chatId, senderId, 'Sessions', { kind: 'sessions', page: 0 }),
        this.button(adapter.id, chatId, senderId, 'New', { kind: 'new' }),
      ],
      [
        this.button(adapter.id, chatId, senderId, 'Model', { kind: 'models', sessionId }),
        this.button(adapter.id, chatId, senderId, 'Reasoning', { kind: 'reasoning', sessionId }),
      ],
      [
        this.button(adapter.id, chatId, senderId, 'Permission', { kind: 'permission', sessionId }),
        this.button(adapter.id, chatId, senderId, 'Context', { kind: 'context', sessionId }),
      ],
    ];
    if (state === 'running') rows.push([
      this.button(adapter.id, chatId, senderId, 'Cancel turn', { kind: 'cancel', sessionId }),
    ]);
    await adapter.sendText(chatId, text, { keyboard: callbackKeyboard(rows) });
  }

  private async showModels(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId = this.binding(adapter.id, chatId),
  ): Promise<void> {
    const directory = await this.control.models(sessionId);
    const buttons = directory.groups.flatMap((group) => group.models.map((model) => ({ group, model })));
    const rows = buttons.slice(0, MAX_MODEL_BUTTONS).map(({ group, model }) => [this.button(
      adapter.id,
      chatId,
      senderId,
      `${directory.current.provider === group.id && directory.current.model === model.id ? '✓ ' : ''}${group.name}: ${model.name}`.slice(0, 60),
      { kind: 'select-model', sessionId, provider: group.id, model: model.id },
    )]);
    rows.push([this.button(adapter.id, chatId, senderId, 'Back', { kind: 'menu' })]);
    await adapter.sendText(
      chatId,
      buttons.length > MAX_MODEL_BUTTONS
        ? `Choose a model. Showing the first ${MAX_MODEL_BUTTONS} of ${buttons.length}.`
        : 'Choose a model. The change applies to the next model step.',
      { keyboard: callbackKeyboard(rows) },
    );
  }

  private async selectModel(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId: string,
    provider: string,
    model: string,
  ): Promise<void> {
    const selected = await this.control.selectModel(sessionId, provider, model);
    await adapter.sendText(chatId, `Model set to ${selected.provider}/${selected.model}.`);
    await this.showReasoning(adapter, chatId, senderId, sessionId);
  }

  private async showReasoning(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId = this.binding(adapter.id, chatId),
  ): Promise<void> {
    const directory = await this.control.models(sessionId);
    const group = directory.groups.find((candidate) => candidate.id === directory.current.provider);
    const model = group?.models.find((candidate) => candidate.id === directory.current.model);
    const efforts = model?.reasoning?.efforts ?? [];
    if (efforts.length === 0) {
      await adapter.sendText(chatId, 'This model does not advertise reasoning controls.', {
        keyboard: callbackKeyboard([[
          this.button(adapter.id, chatId, senderId, 'Back', { kind: 'menu' }),
        ]]),
      });
      return;
    }
    const rows = [[this.button(
      adapter.id,
      chatId,
      senderId,
      `${directory.current.reasoningEffort === undefined ? '✓ ' : ''}Provider default`,
      { kind: 'select-reasoning', sessionId },
    )], ...efforts.map((effort) => [this.button(
      adapter.id,
      chatId,
      senderId,
      `${directory.current.reasoningEffort === effort.id ? '✓ ' : ''}${effort.name}`,
      { kind: 'select-reasoning', sessionId, effort: effort.id },
    )])];
    rows.push([this.button(adapter.id, chatId, senderId, 'Back', { kind: 'menu' })]);
    await adapter.sendText(chatId, 'Choose reasoning effort. The change applies to the next model step.', {
      keyboard: callbackKeyboard(rows),
    });
  }

  private async selectReasoning(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId: string,
    effort: string | undefined,
  ): Promise<void> {
    const directory = await this.control.models(sessionId);
    const selected = await this.control.selectModel(
      sessionId,
      directory.current.provider,
      directory.current.model,
      effort,
    );
    await adapter.sendText(chatId, `Reasoning set to ${selected.reasoningEffort ?? 'provider default'}.`);
    await this.showDashboard(adapter, chatId, senderId);
  }

  private async showPermissions(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId = this.binding(adapter.id, chatId),
  ): Promise<void> {
    const permission = await this.control.permission(sessionId);
    const rows = permission.options.map((option) => [this.button(
      adapter.id,
      chatId,
      senderId,
      `${permission.current === option.value ? '✓ ' : ''}${option.name}`,
      { kind: 'select-permission', sessionId, preset: option.value },
    )]);
    rows.push([this.button(adapter.id, chatId, senderId, 'Back', { kind: 'menu' })]);
    await adapter.sendText(chatId, `Permission preset: ${permission.current}`, {
      keyboard: callbackKeyboard(rows),
    });
  }

  private async setPermission(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId: string,
    preset: string,
  ): Promise<void> {
    await this.control.setPermission(sessionId, preset);
    await adapter.sendText(chatId, `Permission preset set to ${preset}.`);
    await this.showDashboard(adapter, chatId, senderId);
  }

  private async showContext(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId = this.binding(adapter.id, chatId),
  ): Promise<void> {
    const snapshot = await this.control.snapshot(sessionId);
    const context = snapshot.context;
    await adapter.sendText(chatId, [
      `Context · ${sessionTitle(snapshot.summary)}`,
      `Projected next prompt: ${compactNumber(context.projectedTokens)} tokens`,
      `Last provider pressure: ${compactNumber(context.pressureTokens)} tokens`,
      `Context window: ${compactNumber(context.contextWindow)} tokens`,
      '',
      'Approximate composition',
      `System: ${compactNumber(context.systemTokens)}`,
      `Tools: ${compactNumber(context.toolsTokens)}`,
      `Messages: ${compactNumber(context.messageTokens)}`,
      '',
      'Cumulative provider usage',
      `Uncached input: ${compactNumber(context.uncachedInputTokens)}`,
      `Cache read/write: ${compactNumber(context.cacheReadTokens)}/${compactNumber(context.cacheWriteTokens)}`,
      `Output: ${compactNumber(context.outputTokens)}`,
    ].join('\n'), {
      keyboard: callbackKeyboard([[
        this.button(adapter.id, chatId, senderId, 'Refresh', { kind: 'context', sessionId }),
        this.button(adapter.id, chatId, senderId, 'New session', { kind: 'new' }),
      ], [this.button(adapter.id, chatId, senderId, 'Back', { kind: 'menu' })]]),
    });
  }

  private async cancel(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId = this.binding(adapter.id, chatId),
  ): Promise<void> {
    const cancelled = await this.control.cancel(sessionId);
    await adapter.sendText(
      chatId,
      cancelled ? `Cancellation requested for ${shortId(sessionId)}.` : 'No active turn to cancel.',
      { keyboard: this.mainKeyboard(adapter.id, chatId, senderId) },
    );
  }

  private mainKeyboard(transport: string, chatId: string, senderId: string): MessengerInlineKeyboard {
    return callbackKeyboard([[
      this.button(transport, chatId, senderId, 'Sessions', { kind: 'sessions', page: 0 }),
      this.button(transport, chatId, senderId, 'New session', { kind: 'new' }),
    ]]);
  }

  private button(
    transport: string,
    chatId: string,
    senderId: string,
    text: string,
    action: CallbackAction,
  ): { text: string; callbackData: string } {
    this.pruneCallbacks();
    const token = randomUUID().replaceAll('-', '');
    this.callbacks.set(token, {
      transport,
      chatId,
      senderId,
      bindingRevision: this.bindingRevisions.get(bindingKey(transport, chatId)) ?? 0,
      expiresAt: Date.now() + CALLBACK_TTL_MS,
      action,
    });
    return { text, callbackData: `m:${token}` };
  }

  private pruneCallbacks(): void {
    const now = Date.now();
    for (const [token, record] of this.callbacks) {
      if (record.expiresAt < now) this.callbacks.delete(token);
    }
  }

  private binding(transport: string, chatId: string): string {
    const sessionId = this.bindings.get(bindingKey(transport, chatId));
    if (sessionId === undefined) throw new Error('No session selected. Use /resume or /new.');
    return sessionId;
  }

  private async beginProgress(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId: string,
  ): Promise<ProgressState> {
    const key = `${bindingKey(adapter.id, chatId)}:${sessionId}`;
    const previous = this.progress.get(key);
    if (previous !== undefined) {
      await previous.ready;
      return previous;
    }
    const state: ProgressState = {
      key,
      adapter,
      chatId,
      sessionId,
      ready: Promise.resolve(),
      text: '',
      status: [],
      toolNames: new Map(),
      editTimer: undefined,
      typingTimer: undefined,
      turnEnded: false,
    };
    this.progress.set(key, state);
    void adapter.sendTyping(chatId).catch((error: unknown) => this.logProgressError(error));
    state.typingTimer = setInterval(() => {
      void adapter.sendTyping(chatId).catch((error: unknown) => this.logProgressError(error));
    }, TYPING_REFRESH_MS);
    state.typingTimer.unref?.();
    state.ready = adapter.sendText(chatId, 'Deep diving…', {
      keyboard: callbackKeyboard([[
        this.button(adapter.id, chatId, senderId, 'Cancel', { kind: 'cancel', sessionId }),
      ]]),
    }).then((handle) => {
      state.handle = handle;
    });
    try {
      await state.ready;
      return state;
    } catch (error) {
      this.stopProgressTimers(state);
      if (this.progress.get(key) === state) this.progress.delete(key);
      throw error;
    }
  }

  private async beginProgressForBindings(sessionId: string): Promise<void> {
    const starts: Promise<unknown>[] = [];
    for (const [key, bound] of this.bindings) {
      if (bound !== sessionId) continue;
      const separator = key.indexOf(':');
      const adapter = this.adapters.get(key.slice(0, separator));
      if (adapter === undefined) continue;
      const chatId = key.slice(separator + 1);
      const senderId = this.bindingOperators.get(key) ?? chatId;
      starts.push(this.beginProgress(adapter, chatId, senderId, sessionId));
    }
    await Promise.all(starts);
  }

  private progressStates(sessionId: string): ProgressState[] {
    return [...this.progress.values()].filter((state) => state.sessionId === sessionId);
  }

  private hasBindings(sessionId: string): boolean {
    return [...this.bindings.values()].includes(sessionId);
  }

  private scheduleProgressEdits(states: readonly ProgressState[]): void {
    for (const state of states) {
      if (state.handle === undefined || state.editTimer !== undefined) continue;
      state.editTimer = setTimeout(() => {
        state.editTimer = undefined;
        void this.flushProgress(state).catch((error: unknown) => this.logProgressError(error));
      }, PROGRESS_EDIT_INTERVAL_MS);
      state.editTimer.unref?.();
    }
  }

  private async flushProgress(state: ProgressState): Promise<void> {
    await state.ready;
    if (state.handle === undefined) return;
    const rendered = progressText(state);
    if (rendered === state.lastRendered) return;
    state.lastRendered = rendered;
    const keyboard = state.turnEnded ? [] : undefined;
    await this.enqueueOutbound(state.key, () => state.adapter.editText(
      state.chatId,
      state.handle!.messageId,
      rendered,
      keyboard,
    ));
  }

  private async finalizeProgress(state: ProgressState): Promise<void> {
    if (state.editTimer !== undefined) {
      clearTimeout(state.editTimer);
      state.editTimer = undefined;
    }
    this.stopProgressTimers(state);
    try {
      await state.ready;
      const finalText = state.text.trim() || progressText(state);
      const chunks = splitTelegramText(finalText);
      if (state.handle === undefined) {
        await state.adapter.sendText(state.chatId, finalText);
      } else {
        await this.enqueueOutbound(state.key, async () => {
          await state.adapter.editText(state.chatId, state.handle!.messageId, chunks[0] ?? 'Finished.', []);
          for (const chunk of chunks.slice(1)) await state.adapter.sendText(state.chatId, chunk);
        });
      }
    } finally {
      if (this.progress.get(state.key) === state) this.progress.delete(state.key);
    }
  }

  private async failProgress(
    adapter: MessengerAdapter,
    chatId: string,
    sessionId: string,
    error: unknown,
  ): Promise<void> {
    const key = `${bindingKey(adapter.id, chatId)}:${sessionId}`;
    const state = this.progress.get(key);
    if (state === undefined) {
      await adapter.sendText(chatId, `Could not send the prompt: ${this.errorMessage(error)}`);
      return;
    }
    state.text = '';
    state.status.push(`❌ Could not send prompt: ${this.errorMessage(error)}`);
    state.turnEnded = true;
    await this.finalizeProgress(state);
  }

  private stopProgressTimers(state: ProgressState): void {
    if (state.typingTimer !== undefined) {
      clearInterval(state.typingTimer);
      state.typingTimer = undefined;
    }
    if (state.editTimer !== undefined) {
      clearTimeout(state.editTimer);
      state.editTimer = undefined;
    }
  }

  private async sendToBindings(sessionId: string, text: string): Promise<void> {
    const sends: Promise<unknown>[] = [];
    for (const [key, boundSessionId] of this.bindings) {
      if (boundSessionId !== sessionId) continue;
      const separator = key.indexOf(':');
      const adapter = this.adapters.get(key.slice(0, separator));
      if (adapter !== undefined) sends.push(this.enqueueOutbound(
        key,
        () => adapter.sendText(key.slice(separator + 1), text),
      ));
    }
    await Promise.all(sends);
  }

  private enqueueAction<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.actionQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      if (this.disposed) throw new Error('Messenger bridge is disposed.');
      return action();
    });
    this.actionQueues.set(key, current);
    void current.finally(() => {
      if (this.actionQueues.get(key) === current) this.actionQueues.delete(key);
    }).catch(() => undefined);
    return current;
  }

  private enqueueOutbound<T>(key: string, send: () => Promise<T>): Promise<T> {
    const previous = this.outboundQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(send);
    this.outboundQueues.set(key, current);
    void current.finally(() => {
      if (this.outboundQueues.get(key) === current) this.outboundQueues.delete(key);
    }).catch(() => undefined);
    return current;
  }

  private logProgressError(error: unknown): void {
    this.ctx.logger.warn('messenger: progressive Telegram update failed: %o', error);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
