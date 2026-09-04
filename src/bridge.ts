import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions';
import type { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { DshControl, sessionTitle, visibleAssistantText } from './control.js';
import { splitTelegramText } from './telegram.js';
import type { NotificationStore, Subscription } from './notification-store.js';
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
const QUESTION_CALLBACK_TTL_MS = 24 * 60 * 60_000;
const SESSION_PAGE_SIZE = 7;
const WORKSPACE_PAGE_SIZE = 7;
const MODEL_PAGE_SIZE = 8;
const PROGRESS_EDIT_INTERVAL_MS = 750;
const PROGRESS_ANIMATION_INTERVAL_MS = 1_600;
const TYPING_REFRESH_MS = 4_000;
const DEFAULT_PROGRESS_LIMIT = 4_096;
const PROGRESS_SPINNER_FRAMES = ['✦', '✧', '✶', '✳', '✢', '✳', '✶', '✧'] as const;
const THINKING_LABELS = [
  'Thinking',
  'Exploring',
  'Investigating',
  'Mapping it out',
  'Following the thread',
  'Working through it',
  'Checking the details',
  'Connecting the dots',
  'Narrowing it down',
  'Making progress',
  'Looking closer',
  'Sorting it out',
  'Tracing the path',
  'Reviewing the pieces',
  'Putting it together',
  'Double-checking',
] as const;
const THINKING_LABEL_FRAME_SPAN = 3;

export type BridgeContext = {
  readonly agents: AgentRegistry;
  readonly sessionController: SessionController;
  readonly workspaceRegistry: WorkspaceRegistry;
  readonly permissionPresets: PermissionPresetService;
  readonly logger: Context['logger'];
};

export interface MessengerBridgeOptions {
  readonly notificationStore?: NotificationStore;
  readonly allowedChatIds: readonly string[];
  readonly allowedUserIds: readonly string[];
  readonly privateChatsOnly: boolean;
}

type CallbackAction =
  | { readonly kind: 'menu' }
  | { readonly kind: 'sessions'; readonly page: number }
  | { readonly kind: 'bind'; readonly sessionId: string }
  | { readonly kind: 'new' }
  | { readonly kind: 'workspaces'; readonly page: number }
  | { readonly kind: 'create'; readonly workspaceId?: WorkspaceId }
  | { readonly kind: 'models'; readonly sessionId: string }
  | { readonly kind: 'provider-models'; readonly sessionId: string; readonly provider: string; readonly page: number }
  | { readonly kind: 'select-model'; readonly sessionId: string; readonly provider: string; readonly model: string }
  | { readonly kind: 'reasoning'; readonly sessionId: string }
  | { readonly kind: 'question-select'; readonly sessionId: string; readonly questionRpcId: string; readonly questionId: string; readonly label: string }
  | { readonly kind: 'question-toggle'; readonly sessionId: string; readonly questionRpcId: string; readonly questionId: string; readonly label: string }
  | { readonly kind: 'question-submit'; readonly sessionId: string; readonly questionRpcId: string; readonly questionId: string }
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

type QuestionItem = AskUserQuestionItem;

interface QuestionAnswerItem {
  readonly id: string;
  readonly selected: string[];
  readonly custom?: string;
}

interface PendingQuestionRequest {
  readonly rpcId: string;
  readonly sessionId: string;
  readonly questions: readonly QuestionItem[];
  readonly submit: (answer: AskUserQuestionAnswer) => Promise<boolean>;
  readonly reject: (reason: unknown) => void;
}

interface PendingQuestionState extends PendingQuestionRequest {
  readonly key: string;
  readonly adapter: MessengerAdapter;
  readonly chatId: string;
  readonly senderId: string;
  index: number;
  readonly answers: QuestionAnswerItem[];
  readonly selected: Set<string>;
  readonly callbackTokens: Set<string>;
  handle?: MessengerMessageHandle;
}

interface QuestionRetryState {
  readonly rpcId: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly delayMs: number;
}

interface ToolProgress {
  readonly callId: string;
  readonly name: string;
  readonly label: string;
  readonly startedAt: number;
  completedAt?: number;
  outcome: 'running' | 'completed' | 'failed';
}

type ProgressPhase = 'thinking' | 'responding';

interface ProgressState {
  readonly key: string;
  readonly adapter: MessengerAdapter;
  readonly chatId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  handle?: MessengerMessageHandle;
  ready: Promise<void>;
  text: string;
  readonly status: string[];
  readonly tools: Map<string, ToolProgress>;
  readonly toolOrder: string[];
  phase: ProgressPhase;
  readonly thinkingOffset: number;
  animationFrame: number;
  animationTimer: ReturnType<typeof setInterval> | undefined;
  editTimer: ReturnType<typeof setTimeout> | undefined;
  typingTimer: ReturnType<typeof setInterval> | undefined;
  flushInFlight: boolean;
  flushRequested: boolean;
  lastRendered?: string;
  turnEnded: boolean;
  finalizing: boolean;
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

function truncateLabel(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join('')}…`;
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

function stateTag(state: 'running' | 'idle' | 'dormant'): string {
  if (state === 'running') return '🟢 running';
  if (state === 'idle') return '⚪ idle';
  return '💤 dormant';
}

function permissionTag(permission: string): string {
  if (permission === 'danger-full-access') return '🔓 full access';
  if (permission === 'workspace-write') return '✏️ workspace';
  if (permission === 'read-only') return '👁 read only';
  return `🛡 ${permission.replaceAll('-', ' ')}`;
}

function helpText(): string {
  return [
    'DeepSeek Harness messenger controls',
    '',
    '/menu — open the control panel',
    '/sessions or /resume — choose a persisted session',
    '/new — choose a workspace, then create and bind a new session',
    '/status — show the current session dashboard',
    '/model — choose provider and model',
    '/reasoning — choose reasoning effort',
    '/permission — choose the DSH permission preset',
    '/context — show context and token usage',
    '/steer <text> — steer the active turn',
    '/cancel — cancel the active turn',
    '/unbind — remove the binding',
    '/notifications on|off — enable or disable persistent Host-wide notifications',
    '/help — show this help',
    '',
    'Any other text is sent to the bound DSH session.',
  ].join('\n');
}

function actionSessionId(action: CallbackAction): string | undefined {
  switch (action.kind) {
    case 'models':
    case 'provider-models':
    case 'select-model':
    case 'reasoning':
    case 'question-select':
    case 'question-toggle':
    case 'question-submit':
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

function concise(value: string, limit = 72): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(compact);
  return characters.length <= limit ? compact : `${characters.slice(0, limit - 1).join('')}…`;
}

function toolArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringArgument(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function humanizeToolName(name: string): string {
  const leaf = name.split(/[./:]/).filter(Boolean).at(-1) ?? 'tool';
  const words = leaf.replaceAll('_', ' ').replaceAll('-', ' ').trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : 'Tool';
}

function quoted(value: string): string {
  return `“${concise(value, 56)}”`;
}

function summarizeToolCall(name: string, rawArguments: string): string {
  const args = toolArguments(rawArguments);
  const leaf = name.split(/[./:]/).filter(Boolean).at(-1)?.toLowerCase() ?? name.toLowerCase();
  const filePath = stringArgument(args, 'file_path');
  const path = stringArgument(args, 'path');
  const target = filePath ?? path;

  if (leaf === 'read' && target !== undefined) {
    const offset = typeof args?.offset === 'number' ? args.offset : undefined;
    const limit = typeof args?.limit === 'number' ? args.limit : undefined;
    const window = offset === undefined
      ? ''
      : ` · lines ${offset}${limit === undefined ? '+' : `–${offset + Math.max(0, limit - 1)}`}`;
    return `Reading ${concise(target)}${window}`;
  }
  if (leaf === 'read_image' && target !== undefined) return `Inspecting ${concise(target)}`;
  if ((leaf === 'write' || leaf === 'edit') && target !== undefined) {
    return `${leaf === 'write' ? 'Writing' : 'Editing'} ${concise(target)}`;
  }
  if (leaf === 'glob') {
    const pattern = stringArgument(args, 'pattern');
    const where = stringArgument(args, 'path');
    if (pattern !== undefined) return `Finding ${quoted(pattern)}${where === undefined ? '' : ` in ${concise(where, 44)}`}`;
  }
  if (leaf === 'grep') {
    const pattern = stringArgument(args, 'pattern');
    const where = stringArgument(args, 'path');
    if (pattern !== undefined) return `Searching for ${quoted(pattern)}${where === undefined ? '' : ` in ${concise(where, 40)}`}`;
  }
  if (leaf === 'bash') {
    const description = stringArgument(args, 'description');
    return description === undefined ? 'Running a command' : concise(description);
  }
  if (leaf === 'web_search') {
    const queries = args?.queries;
    if (Array.isArray(queries)) {
      const first = queries.find((query): query is string => typeof query === 'string' && query.trim().length > 0);
      if (first !== undefined) return `Searching the web for ${quoted(first)}`;
    }
    return 'Searching the web';
  }
  if (leaf === 'skill') {
    const skill = stringArgument(args, 'name');
    if (skill !== undefined) return `Loading ${concise(skill, 48)} guidance`;
  }
  if (leaf === 'subagent' || leaf === 'subagent_fork') {
    const description = stringArgument(args, 'description');
    return description === undefined ? 'Delegating a task' : `Delegating · ${concise(description, 52)}`;
  }
  if (leaf === 'todo_write') return 'Updating the plan';
  if (leaf === 'ask_user_question') return 'Preparing a question';
  if (leaf === 'job_output') return 'Checking background work';
  if (leaf === 'create_goal' || leaf === 'update_goal') return 'Updating the goal';

  return humanizeToolName(safeToolName(name));
}

function elapsedSuffix(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  return seconds < 2 ? '' : ` · ${seconds}s`;
}

function progressActivity(state: ProgressState): string {
  const waiting = state.status.includes('❓ Waiting for your answer');
  if (waiting) return '❓ Waiting for your answer';

  const tools = state.toolOrder
    .map((callId) => state.tools.get(callId))
    .filter((tool): tool is ToolProgress => tool !== undefined);
  const active = [...tools].reverse().find((tool) => tool.outcome === 'running');
  const spinner = PROGRESS_SPINNER_FRAMES[state.animationFrame % PROGRESS_SPINNER_FRAMES.length]!;
  const thinking = THINKING_LABELS[
    (
      state.thinkingOffset
      + Math.floor(state.animationFrame / THINKING_LABEL_FRAME_SPAN)
    ) % THINKING_LABELS.length
  ]!;
  const label = active?.label ?? (state.phase === 'responding' ? 'Writing the response' : thinking);
  const startedAt = active?.startedAt ?? state.startedAt;
  // The animated spinner lives at the end of the line and the activity line is
  // rendered last, so frame width changes never shift the message's leading text.
  return `${label}…${elapsedSuffix(startedAt)} ${spinner}`;
}

function pushStatus(state: ProgressState, line: string): void {
  for (let index = state.status.length - 1; index >= 0; index -= 1) {
    if (state.status[index] === line) state.status.splice(index, 1);
  }
  state.status.push(line);
}

function replaceStatus(state: ProgressState, prefix: string, line: string): void {
  for (let index = state.status.length - 1; index >= 0; index -= 1) {
    if (state.status[index]?.startsWith(prefix)) state.status.splice(index, 1);
  }
  pushStatus(state, line);
}

function progressDetails(state: ProgressState): string {
  const waiting = state.status.includes('❓ Waiting for your answer');
  const tools = state.toolOrder
    .map((callId) => state.tools.get(callId))
    .filter((tool): tool is ToolProgress => tool !== undefined);
  const active = [...tools].reverse().find((tool) => tool.outcome === 'running');
  const toolLines = tools
    .filter((tool) => tool !== active)
    .slice(-3)
    .map((tool) => `${tool.outcome === 'running' ? '◌' : tool.outcome === 'completed' ? '✓' : '×'} ${tool.label}`);
  const statusLines = state.status
    .filter((line) => !waiting || line !== '❓ Waiting for your answer')
    .slice(-2);
  return [...toolLines, ...statusLines].slice(-4).join('\n');
}

function clipPlainTail(
  value: string,
  limit: number,
  measure: (text: string) => number,
): string {
  if (measure(value) <= limit) return value;
  if (limit <= 0) return '';
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  let best = measure('…') <= limit ? '…' : '';
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = count === 0 ? '…' : `…${characters.slice(-count).join('')}`;
    if (measure(candidate) <= limit) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return best;
}

function progressText(state: ProgressState): string {
  const rawBody = state.text.trim();
  const activity = state.turnEnded ? '' : progressActivity(state);
  const details = progressDetails(state);
  const placeholder = state.turnEnded ? 'Finished.' : '';
  const limit = state.adapter.textLimit ?? DEFAULT_PROGRESS_LIMIT;
  const measure = (value: string): number => (
    state.adapter.textLength?.(value) ?? Array.from(value).length
  );
  const renderBody = (value: string): string => (
    value && state.adapter.renderText !== undefined ? state.adapter.renderText(value) : value
  );
  // Response body leads; the status trail and the animated activity line are
  // pinned to the message tail so the leading text never shifts mid-stream.
  const compose = (body: string): string => [
    body || placeholder,
    details,
    activity,
  ].filter(Boolean).join('\n\n');

  const rendered = compose(renderBody(rawBody));
  if (measure(rendered) <= limit) return rendered;
  if (!rawBody) return clipPlainTail(rendered, limit, measure);

  const rawCharacters = Array.from(rawBody);
  let low = 0;
  let high = rawCharacters.length;
  let best = '';
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = count === 0
      ? ''
      : `${count < rawCharacters.length ? '…\n' : ''}${rawCharacters.slice(-count).join('')}`;
    const candidateRendered = compose(renderBody(candidate));
    if (measure(candidateRendered) <= limit) {
      best = candidateRendered;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return best || clipPlainTail(compose(''), limit, measure);
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
  private readonly questionRequests = new Map<string, PendingQuestionRequest>();
  private readonly pendingQuestions = new Map<string, PendingQuestionState>();
  private readonly questionRetries = new Map<string, QuestionRetryState>();
  private readonly questionRetryDelays = new Map<string, number>();
  private readonly resolvingQuestions = new Set<string>();
  private readonly control: DshControl;
  private readonly notificationStore: NotificationStore | undefined;
  private nextThinkingOffset = 0;
  private disposed = false;

  constructor(
    private readonly ctx: BridgeContext,
    options: MessengerBridgeOptions,
  ) {
    this.allowedChatIds = new Set(options.allowedChatIds);
    this.allowedUserIds = new Set(options.allowedUserIds);
    this.privateChatsOnly = options.privateChatsOnly;
    this.control = new DshControl(ctx);
    this.notificationStore = options.notificationStore;
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

    const key = bindingKey(adapter.id, message.chatId);
    if (parseCommand(message.text) === undefined && !this.bindings.has(key)) {
      await adapter.sendText(
        message.chatId,
        'No session selected. Use /resume to choose one or /new to create one.',
        { keyboard: this.mainKeyboard(adapter.id, message.chatId, message.senderId) },
      );
      return;
    }
    await this.enqueueAction(key, () => this.handleTextMessage(adapter, message));
  }

  private async handleTextMessage(
    adapter: MessengerAdapter,
    message: InboundTextMessage,
  ): Promise<void> {
    const command = parseCommand(message.text);
    if (command?.name === 'notifications') {
      await this.handleNotificationsCommand(adapter, message, command.argument);
      return;
    }
    if (command !== undefined) {
      await this.handleCommand(adapter, message.chatId, message.senderId, command);
      return;
    }

    const key = bindingKey(message.transport, message.chatId);
    const pendingQuestion = this.pendingQuestions.get(key);
    if (pendingQuestion !== undefined) {
      try {
        await this.answerQuestionWithText(pendingQuestion, message.text);
      } catch (error) {
        await adapter.sendText(
          message.chatId,
          `Could not submit that answer: ${this.errorMessage(error)}. Please try again.`,
        );
      }
      return;
    }

    const sessionId = this.bindings.get(key);
    if (sessionId === undefined) {
      await adapter.sendText(
        message.chatId,
        'No session selected. Use /resume to choose one or /new to create one.',
        { keyboard: this.mainKeyboard(adapter.id, message.chatId, message.senderId) },
      );
      return;
    }

    void this.beginProgress(adapter, message.chatId, message.senderId, sessionId)
      .catch((error: unknown) => {
        this.ctx.logger.warn(
          'messenger: failed to show progress before submitting prompt: %o',
          error,
        );
      });
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
      this.beginProgressForBindings(sessionId);
    }

    const active = this.progressStates(sessionId);
    if (active.length === 0) {
      const finalText = visibleAssistantText(event);
      if (finalText !== undefined) await this.sendToBindings(sessionId, finalText);
      return;
    }

    if (event.type === 'assistant/chunk') {
      if (event.data.chunk.type === 'text-delta') {
        for (const state of active) {
          state.text += event.data.chunk.text;
          state.phase = 'responding';
        }
      } else if (event.data.chunk.type === 'reasoning-delta') {
        for (const state of active) state.phase = 'thinking';
      }
      this.scheduleProgressEdits(active);
      return;
    }

    if (event.type === 'assistant/message') {
      const text = visibleAssistantText(event);
      if (text !== undefined) {
        for (const state of active) {
          state.text = text;
          state.phase = 'responding';
        }
      }
      if (event.data.interrupted) {
        for (const state of active) pushStatus(state, '⏹ Interrupted');
      }
      this.scheduleProgressEdits(active);
      return;
    }

    if (event.type === 'tool/call') {
      const name = safeToolName(event.data.name);
      const callId = String(event.data.callId);
      const label = summarizeToolCall(name, event.data.arguments);
      for (const state of active) {
        state.tools.set(callId, {
          callId,
          name,
          label,
          startedAt: event.time,
          outcome: 'running',
        });
        const previous = state.toolOrder.indexOf(callId);
        if (previous >= 0) state.toolOrder.splice(previous, 1);
        state.toolOrder.push(callId);
        state.phase = 'thinking';
      }
      this.scheduleProgressEdits(active);
      return;
    }

    if (event.type === 'tool/result') {
      const callId = String(event.data.message.source.callId);
      for (const state of active) {
        const tool = state.tools.get(callId);
        if (tool !== undefined) {
          tool.completedAt = event.time;
          tool.outcome = event.data.error === undefined ? 'completed' : 'failed';
        } else {
          state.tools.set(callId, {
            callId,
            name: 'tool',
            label: 'Tool call',
            startedAt: event.time,
            completedAt: event.time,
            outcome: event.data.error === undefined ? 'completed' : 'failed',
          });
          state.toolOrder.push(callId);
        }
        state.phase = 'thinking';
      }
      this.scheduleProgressEdits(active);
      return;
    }

    if (event.type === 'turn/end') {
      for (const state of active) {
        state.turnEnded = true;
        if (event.data.reason.kind === 'aborted') pushStatus(state, '⏹ Cancelled');
        if (event.data.reason.kind === 'error') pushStatus(state, '❌ Turn failed');
        if (event.data.reason.kind === 'blocked') pushStatus(state, '⏸ Blocked');
        if (event.data.reason.kind === 'max-tokens') pushStatus(state, '⚠️ Output limit reached');
        if (this.progress.get(state.key) === state) this.progress.delete(state.key);
      }
      for (const state of active) {
        void this.finalizeProgress(state).catch((error: unknown) => {
          this.ctx.logger.warn(
            'messenger: failed to finalize progress for one binding: %o',
            error,
          );
        });
      }
    }
  }

  private notificationRecipients(): Subscription[] {
    return [...this.adapters.keys()].flatMap((transport) => this.notificationStore?.list(transport) ?? [])
      .filter((subscription) => this.authorized(subscription));
  }

  canNotify(sessionId: string): boolean {
    return !this.disposed && (this.notificationStore === undefined
      ? this.hasBindings(sessionId) : this.notificationRecipients().length > 0);
  }

  private async handleNotificationsCommand(
    adapter: MessengerAdapter,
    message: InboundTextMessage,
    argument: string,
  ): Promise<void> {
    const store = this.notificationStore;
    if (store === undefined) {
      await adapter.sendText(message.chatId, 'Persistent notifications are unavailable.');
      return;
    }
    let response: string;
    try {
      switch (argument.toLowerCase()) {
        case 'on':
          await store.subscribe(message);
          response = '🔔 Notifications enabled for this chat. Any automation or top-level session on this DSH Host can send status here, regardless of the selected session. '
            + 'Everyone in a group can read them. The subscription survives restarts and /unbind. '
            + 'Use /notifications off to unsubscribe.';
          break;
        case 'off':
          await store.unsubscribe(adapter.id, message.chatId);
          response = '🔕 Notifications disabled for this chat. Old notification buttons are now invalid.';
          break;
        default: {
          const subscribed = store.get(adapter.id, message.chatId) !== undefined;
          response = `Notifications: ${subscribed ? 'on' : 'off'}.\n/notifications on — receive Host-wide automation statuses without selecting a session.\n/notifications off — unsubscribe.\nOpening a notification session is always an explicit button click.`;
        }
      }
    } catch (error) {
      this.ctx.logger.warn('messenger: notification subscription could not be saved: %o', error);
      await adapter.sendText(message.chatId, 'Could not save notification preferences. Please try again.');
      return;
    }
    // A failed acknowledgement must not misreport a successfully persisted subscription.
    await adapter.sendText(message.chatId, response);
  }

  private async notifySubscribers(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ sent: number; failed: number; skipped: number }> {
    const store = this.notificationStore!;
    const recipients = this.notificationRecipients();
    if (recipients.length === 0) throw new Error('No notification subscribers. Send /notifications on in an allowed bot chat first.');
    const sends = recipients.map((subscription) => this.enqueueOutbound(
      bindingKey(subscription.transport, subscription.chatId),
      async () => {
        const current = () => !this.disposed && !signal?.aborted
          && store.get(subscription.transport, subscription.chatId)?.id === subscription.id;
        if (!current()) return false;
        const token = await store.createLink(subscription, sessionId);
        if (!current()) return false;
        const adapter = this.adapters.get(subscription.transport)!;
        await adapter.sendText(subscription.chatId, adapter.renderText?.(text) ?? text, {
          keyboard: [[{ text: 'Открыть сессию', callbackData: `n:${token}` }]],
        });
        return true;
      },
    ));
    const results = await Promise.allSettled(sends);
    return {
      sent: results.filter((result) => result.status === 'fulfilled' && result.value).length,
      failed: results.filter((result) => result.status === 'rejected').length,
      skipped: results.filter((result) => result.status === 'fulfilled' && !result.value).length,
    };
  }

  /** Send to durable subscribers; standalone library bridges without a store retain legacy binding delivery. */
  async notify(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ sent: number; failed: number; skipped: number }> {
    if (this.disposed) throw new Error('Messenger bridge is disposed.');
    if (!text.trim() || text.length > 16_000) {
      throw new Error('Notification text must contain 1–16000 characters and not be blank.');
    }
    signal?.throwIfAborted();
    if (this.notificationStore !== undefined) return this.notifySubscribers(sessionId, text, signal);
    const sends: Promise<boolean>[] = [];
    for (const [key, boundSessionId] of this.bindings) {
      if (boundSessionId !== sessionId) continue;
      const separator = key.indexOf(':');
      const adapter = this.adapters.get(key.slice(0, separator));
      if (adapter === undefined) continue;
      const revision = this.bindingRevisions.get(key);
      sends.push(this.enqueueOutbound(key, async () => {
        // A queued send must not outlive unbind/rebind, shutdown, or cancellation.
        if (this.disposed || signal?.aborted
          || this.bindings.get(key) !== sessionId
          || this.bindingRevisions.get(key) !== revision) return false;
        await adapter.sendText(key.slice(separator + 1), adapter.renderText?.(text) ?? text);
        return true;
      }));
    }
    if (sends.length === 0) {
      throw new Error('No messenger chat is bound to this session. Use /resume or /new in the bot first.');
    }
    const results = await Promise.allSettled(sends);
    return {
      sent: results.filter((result) => result.status === 'fulfilled' && result.value).length,
      failed: results.filter((result) => result.status === 'rejected').length,
      skipped: results.filter((result) => result.status === 'fulfilled' && !result.value).length,
    };
  }

  async askQuestion(
    sessionId: string,
    questions: readonly QuestionItem[],
    signal?: AbortSignal,
  ): Promise<AskUserQuestionAnswer | undefined> {
    if (this.disposed || !this.hasBindings(sessionId)) return undefined;
    signal?.throwIfAborted();

    const rpcId = `messenger-${randomUUID()}`;
    let resolveAnswer!: (answer: AskUserQuestionAnswer) => void;
    let rejectAnswer!: (reason: unknown) => void;
    const answerPromise = new Promise<AskUserQuestionAnswer>((resolve, rejectPromise) => {
      resolveAnswer = resolve;
      rejectAnswer = rejectPromise;
    });
    let submitted = false;
    const submit = async (answer: AskUserQuestionAnswer): Promise<boolean> => {
      if (submitted) return false;
      submitted = true;
      resolveAnswer(answer);
      return true;
    };
    const reject = (reason: unknown): void => {
      if (submitted) return;
      submitted = true;
      rejectAnswer(reason);
    };

    await this.onQuestionRequested(rpcId, sessionId, questions, submit, reject);
    if (!this.questionRequests.has(rpcId)) return undefined;

    const abort = (): void => {
      reject(signal?.reason ?? new Error('question request aborted'));
      void this.onQuestionResolved(rpcId, 'cancelled');
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await answerPromise;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async onQuestionRequested(
    rpcId: string,
    sessionId: string,
    questions: readonly QuestionItem[],
    submit: (answer: AskUserQuestionAnswer) => Promise<boolean> = async () => false,
    reject: (reason: unknown) => void = () => undefined,
  ): Promise<void> {
    if (this.disposed || questions.length === 0) return;
    const rpcKey = String(rpcId);
    const request = this.questionRequests.get(rpcKey) ?? {
      rpcId,
      sessionId,
      questions,
      submit,
      reject,
    };
    this.questionRequests.set(rpcKey, request);

    const progress = this.progressStates(sessionId);
    for (const state of progress) {
      this.stopTyping(state);
      this.stopAnimation(state);
      if (!state.status.includes('❓ Waiting for your answer')) {
        pushStatus(state, '❓ Waiting for your answer');
      }
    }
    for (const state of progress) {
      void this.flushProgress(state).catch((error: unknown) => {
        this.ctx.logger.warn('messenger: failed to pause progress for user question: %o', error);
      });
    }

    const starts: Promise<unknown>[] = [];
    for (const [key, boundSessionId] of this.bindings) {
      if (boundSessionId !== sessionId) continue;
      starts.push(this.enqueueAction(key, () => this.startQuestionForBinding(key, request)));
    }
    const started = await Promise.allSettled(starts);
    for (const result of started) {
      if (result.status === 'rejected') {
        this.ctx.logger.warn('messenger: failed to show user question: %o', result.reason);
      }
    }
  }

  async onQuestionResolved(
    questionRpcId: string,
    outcome: 'answered' | 'cancelled' = 'answered',
  ): Promise<void> {
    const rpcId = String(questionRpcId);
    this.resolvingQuestions.add(rpcId);
    try {
      const keys = [...this.pendingQuestions.values()]
        .filter((state) => String(state.rpcId) === rpcId)
        .map((state) => state.key);
      await Promise.allSettled(keys.map((key) => this.enqueueAction(key, async () => undefined)));
      await this.settleQuestion(
        rpcId,
        outcome,
        outcome === 'answered' ? '✅ Question resolved.' : '⏹ Question cancelled.',
      );
    } finally {
      this.resolvingQuestions.delete(rpcId);
    }
  }

  private async settleQuestion(
    rpcId: string,
    outcome: 'answered' | 'cancelled',
    resolvedText: string,
  ): Promise<boolean> {
    const request = this.questionRequests.get(rpcId);
    const resolvedStates: PendingQuestionState[] = [];
    for (const state of this.pendingQuestions.values()) {
      if (String(state.rpcId) === rpcId) resolvedStates.push(state);
    }
    if (request === undefined && resolvedStates.length === 0) return false;

    this.questionRequests.delete(rpcId);
    this.clearQuestionRetriesForRpc(rpcId);
    for (const state of resolvedStates) {
      this.clearQuestionCallbacks(state);
      this.pendingQuestions.delete(state.key);
    }
    const sessionId = request?.sessionId ?? resolvedStates[0]?.sessionId;
    const stillPending = sessionId !== undefined && [...this.questionRequests.values()].some(
      (candidate) => candidate.sessionId === sessionId,
    );

    await Promise.allSettled(resolvedStates.map((state) => (
      state.handle === undefined
        ? Promise.resolve()
        : state.adapter.editText(state.chatId, state.handle.messageId, resolvedText, [])
    )));

    if (sessionId !== undefined) {
      const progress = this.progressStates(sessionId);
      for (const state of progress) {
        const waiting = state.status.lastIndexOf('❓ Waiting for your answer');
        if (!stillPending && waiting >= 0) state.status.splice(waiting, 1);
        if (!stillPending) {
          pushStatus(state, outcome === 'answered' ? '✅ Answered' : '⏹ Question cancelled');
          if (!state.turnEnded && outcome === 'answered') {
            this.startTyping(state);
            this.startAnimation(state);
          }
        }
      }
      this.scheduleProgressEdits(progress);
    }

    const promotions = resolvedStates.map(async (state) => {
      const next = [...this.questionRequests.values()].find(
        (candidate) => candidate.sessionId === state.sessionId,
      );
      if (next !== undefined) await this.startQuestionForBinding(state.key, next);
    });
    const promoted = await Promise.allSettled(promotions);
    for (const result of promoted) {
      if (result.status === 'rejected') {
        this.ctx.logger.warn('messenger: failed to show queued user question: %o', result.reason);
      }
    }
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of this.questionRequests.values()) {
      request.reject(new Error('messenger bridge disposed'));
    }
    for (const state of this.progress.values()) this.stopProgressTimers(state);
    this.progress.clear();
    this.callbacks.clear();
    this.questionRequests.clear();
    this.pendingQuestions.clear();
    for (const retry of this.questionRetries.values()) clearTimeout(retry.timer);
    this.questionRetries.clear();
    this.questionRetryDelays.clear();
    this.resolvingQuestions.clear();
    await Promise.allSettled([
      ...this.actionQueues.values(),
      ...this.outboundQueues.values(),
    ]);
  }

  private authorized(message: Pick<Subscription, 'chatId' | 'chatKind' | 'senderId' | 'senderAliases'>): boolean {
    if (!this.allowedChatIds.has(message.chatId)) return false;
    if (message.chatKind === 'private') return true;
    const senderIds = message.senderAliases ?? [message.senderId];
    return !this.privateChatsOnly && senderIds.some((id) => this.allowedUserIds.has(id));
  }

  private async handleNotificationCallback(
    adapter: MessengerAdapter,
    message: InboundCallbackInteraction,
  ): Promise<void> {
    const store = this.notificationStore;
    const token = message.data.slice(2);
    const link = store?.link(token);
    const valid = () => link !== undefined && store?.link(token) !== undefined
      && link.transport === adapter.id && link.chatId === message.chatId
      && link.senderId === message.senderId
      && store.get(adapter.id, message.chatId)?.id === link.subscriptionId;
    if (!valid() || link === undefined) {
      await adapter.answerCallback(message.callbackQueryId, 'This notification expired or belongs to another subscriber.', true);
      return;
    }
    try {
      await adapter.answerCallback(message.callbackQueryId);
    } catch (error) {
      this.ctx.logger.warn('messenger: failed to acknowledge notification button: %o', error);
    }
    await this.enqueueAction(bindingKey(adapter.id, message.chatId), async () => {
      if (!valid()) return;
      try {
        await this.bindSession(adapter, message.chatId, message.senderId, link.sessionId, valid);
      } catch (error) {
        this.ctx.logger.warn('messenger: could not open notification session: %o', error);
        await adapter.sendText(message.chatId, 'Could not open the notification session. It may have been deleted or the subscription changed. Use /resume to choose another session.');
      }
    });
  }

  private async handleCallback(
    adapter: MessengerAdapter,
    message: InboundCallbackInteraction,
  ): Promise<void> {
    if (message.data.startsWith('n:')) {
      await this.handleNotificationCallback(adapter, message);
      return;
    }
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
        await this.showWorkspaces(adapter, chatId, senderId, 0);
        return;
      case 'workspaces':
        await this.showWorkspaces(adapter, chatId, senderId, action.page);
        return;
      case 'create':
        await this.createSession(adapter, chatId, senderId, action.workspaceId);
        return;
      case 'models':
        await this.showModels(adapter, chatId, senderId, action.sessionId);
        return;
      case 'provider-models':
        await this.showProviderModels(
          adapter,
          chatId,
          senderId,
          action.sessionId,
          action.provider,
          action.page,
        );
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
      case 'question-select':
        await this.selectQuestionOption(key, action.questionRpcId, action.questionId, action.label);
        return;
      case 'question-toggle':
        await this.toggleQuestionOption(key, action.questionRpcId, action.questionId, action.label);
        return;
      case 'question-submit':
        await this.submitQuestionSelection(key, action.questionRpcId, action.questionId);
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
          await this.showWorkspaces(adapter, chatId, senderId, 0);
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
          const pending = this.pendingQuestions.get(key);
          if (pending !== undefined) this.clearQuestionCallbacks(pending);
          this.pendingQuestions.delete(key);
          this.clearQuestionRetry(key);
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

  private async startQuestionForBinding(
    key: string,
    request: PendingQuestionRequest,
  ): Promise<void> {
    const existing = this.pendingQuestions.get(key);
    if (existing !== undefined) return;
    const rpcId = String(request.rpcId);
    if (this.questionRequests.get(rpcId) !== request || this.resolvingQuestions.has(rpcId)) return;
    const separator = key.indexOf(':');
    const adapter = this.adapters.get(key.slice(0, separator));
    const chatId = key.slice(separator + 1);
    if (adapter === undefined || this.bindings.get(key) !== request.sessionId) return;
    const state: PendingQuestionState = {
      ...request,
      key,
      adapter,
      chatId,
      senderId: this.bindingOperators.get(key) ?? chatId,
      index: 0,
      answers: [],
      selected: new Set(),
      callbackTokens: new Set(),
    };
    try {
      await this.renderQuestion(state);
      this.pendingQuestions.set(key, state);
      this.clearQuestionRetry(key);
    } catch (error) {
      this.clearQuestionCallbacks(state);
      if (this.questionRequests.get(rpcId) === request) {
        this.scheduleQuestionRetry(key, request);
      }
      throw error;
    }
  }

  private clearQuestionRetry(key: string): void {
    const retry = this.questionRetries.get(key);
    if (retry !== undefined) clearTimeout(retry.timer);
    this.questionRetries.delete(key);
    this.questionRetryDelays.delete(key);
  }

  private scheduleQuestionRetry(key: string, request: PendingQuestionRequest): void {
    const rpcId = String(request.rpcId);
    const current = this.questionRetries.get(key);
    if (current?.rpcId === rpcId) return;
    if (current !== undefined) clearTimeout(current.timer);
    const delayMs = this.questionRetryDelays.get(key) ?? 500;
    const timer = setTimeout(() => {
      this.questionRetries.delete(key);
      if (
        this.disposed
        || this.questionRequests.get(rpcId) !== request
        || this.pendingQuestions.has(key)
        || this.bindings.get(key) !== request.sessionId
      ) {
        this.questionRetryDelays.delete(key);
        return;
      }
      void this.enqueueAction(key, () => this.startQuestionForBinding(key, request))
        .catch((error: unknown) => {
          this.ctx.logger.warn('messenger: question retry failed: %o', error);
        });
    }, delayMs);
    timer.unref?.();
    this.questionRetries.set(key, { rpcId, timer, delayMs });
    this.questionRetryDelays.set(key, Math.min(delayMs * 2, 5_000));
  }

  private clearQuestionRetriesForRpc(rpcId: string): void {
    for (const [key, retry] of this.questionRetries) {
      if (retry.rpcId !== rpcId) continue;
      clearTimeout(retry.timer);
      this.questionRetries.delete(key);
      this.questionRetryDelays.delete(key);
    }
  }

  private async renderQuestion(state: PendingQuestionState): Promise<void> {
    const rpcId = String(state.rpcId);
    if (this.resolvingQuestions.has(rpcId) || this.questionRequests.get(rpcId)?.rpcId !== state.rpcId) {
      throw new Error('This question is no longer active.');
    }
    const question = state.questions[state.index];
    if (question === undefined) return;
    const options = question.options ?? [];
    const heading = question.header?.trim() || `Question ${state.index + 1}/${state.questions.length}`;
    const instructions = options.length === 0
      ? 'Reply with your answer.'
      : question.multiSelect === true
        ? 'Select any number of options, then submit. You can also reply with custom text.'
        : 'Choose one option, or reply with custom text.';
    const optionDetails = options
      .filter((option) => option.description?.trim())
      .map((option) => `• ${option.label} — ${option.description!.trim()}`);
    const text = [
      `❓ ${heading}`,
      '',
      question.question,
      ...(question.detail?.trim() ? ['', question.detail.trim()] : []),
      ...(optionDetails.length === 0 ? [] : ['', ...optionDetails]),
      '',
      instructions,
    ].join('\n');
    const nextTokens = new Set<string>();
    const questionButton = (buttonText: string, action: CallbackAction) => {
      const button = this.button(
        state.adapter.id,
        state.chatId,
        state.senderId,
        buttonText,
        action,
        QUESTION_CALLBACK_TTL_MS,
      );
      nextTokens.add(button.callbackData.slice(2));
      return button;
    };
    const rows = options.map((option) => [questionButton(
      `${state.selected.has(option.label) ? '✓ ' : ''}${truncateLabel(option.label, 52)}`,
      question.multiSelect === true
        ? {
            kind: 'question-toggle',
            sessionId: state.sessionId,
            questionRpcId: String(state.rpcId),
            questionId: question.id,
            label: option.label,
          }
        : {
            kind: 'question-select',
            sessionId: state.sessionId,
            questionRpcId: String(state.rpcId),
            questionId: question.id,
            label: option.label,
          },
    )]);
    if (question.multiSelect === true) rows.push([questionButton(
      state.selected.size === 0 ? 'Submit without selection' : `Submit · ${state.selected.size} selected`,
      {
        kind: 'question-submit',
        sessionId: state.sessionId,
        questionRpcId: String(state.rpcId),
        questionId: question.id,
      },
    )]);
    rows.push([questionButton('Cancel turn', { kind: 'cancel', sessionId: state.sessionId })]);
    const keyboard = callbackKeyboard(rows);
    const renderedText = state.adapter.renderText?.(text) ?? text;
    const editLimit = state.adapter.textLimit ?? DEFAULT_PROGRESS_LIMIT;
    const renderedLength = state.adapter.textLength?.(renderedText)
      ?? Array.from(renderedText).length;
    try {
      if (state.handle === undefined || renderedLength > editLimit) {
        state.handle = await state.adapter.sendText(state.chatId, renderedText, { keyboard });
      } else {
        await state.adapter.editText(state.chatId, state.handle.messageId, renderedText, keyboard);
      }
    } catch (error) {
      for (const token of nextTokens) this.callbacks.delete(token);
      throw error;
    }
    if (this.resolvingQuestions.has(rpcId) || this.questionRequests.get(rpcId)?.rpcId !== state.rpcId) {
      for (const token of nextTokens) this.callbacks.delete(token);
      throw new Error('This question is no longer active.');
    }
    for (const token of state.callbackTokens) this.callbacks.delete(token);
    state.callbackTokens.clear();
    for (const token of nextTokens) state.callbackTokens.add(token);
  }

  private clearQuestionCallbacks(state: PendingQuestionState): void {
    for (const token of state.callbackTokens) this.callbacks.delete(token);
    state.callbackTokens.clear();
  }

  private currentQuestion(
    key: string,
    questionRpcId: string,
    questionId: string,
  ): { state: PendingQuestionState; question: QuestionItem } {
    const state = this.pendingQuestions.get(key);
    const question = state?.questions[state.index];
    if (
      state === undefined
      || this.resolvingQuestions.has(questionRpcId)
      || String(state.rpcId) !== questionRpcId
      || question === undefined
      || question.id !== questionId
    ) {
      throw new Error('This question is no longer active.');
    }
    return { state, question };
  }

  private async selectQuestionOption(
    key: string,
    questionRpcId: string,
    questionId: string,
    label: string,
  ): Promise<void> {
    const { state, question } = this.currentQuestion(key, questionRpcId, questionId);
    if (question.multiSelect === true || !(question.options ?? []).some((option) => option.label === label)) {
      throw new Error('This option is no longer available.');
    }
    await this.advanceQuestion(state, { id: question.id, selected: [label] });
  }

  private async toggleQuestionOption(
    key: string,
    questionRpcId: string,
    questionId: string,
    label: string,
  ): Promise<void> {
    const { state, question } = this.currentQuestion(key, questionRpcId, questionId);
    if (question.multiSelect !== true || !(question.options ?? []).some((option) => option.label === label)) {
      throw new Error('This option is no longer available.');
    }
    const wasSelected = state.selected.has(label);
    if (wasSelected) state.selected.delete(label);
    else state.selected.add(label);
    try {
      await this.renderQuestion(state);
    } catch (error) {
      if (wasSelected) state.selected.add(label);
      else state.selected.delete(label);
      throw error;
    }
  }

  private async submitQuestionSelection(
    key: string,
    questionRpcId: string,
    questionId: string,
  ): Promise<void> {
    const { state, question } = this.currentQuestion(key, questionRpcId, questionId);
    if (question.multiSelect !== true) throw new Error('This question is not multi-select.');
    await this.advanceQuestion(state, { id: question.id, selected: [...state.selected] });
  }

  private async answerQuestionWithText(
    state: PendingQuestionState,
    text: string,
  ): Promise<void> {
    if (this.resolvingQuestions.has(String(state.rpcId))) {
      await state.adapter.sendText(state.chatId, 'This question has already been resolved.');
      return;
    }
    const custom = text.trim();
    const question = state.questions[state.index];
    if (question === undefined) return;
    if (custom.length === 0) {
      await state.adapter.sendText(state.chatId, 'Please send a non-empty answer.');
      return;
    }
    await this.advanceQuestion(state, {
      id: question.id,
      selected: question.multiSelect === true ? [...state.selected] : [],
      custom,
    });
  }

  private async advanceQuestion(
    state: PendingQuestionState,
    answer: QuestionAnswerItem,
  ): Promise<void> {
    const answers = [...state.answers, answer];
    if (state.index + 1 < state.questions.length) {
      const previousIndex = state.index;
      const previousSelected = [...state.selected];
      state.answers.push(answer);
      state.index += 1;
      state.selected.clear();
      try {
        await this.renderQuestion(state);
      } catch (error) {
        state.answers.pop();
        state.index = previousIndex;
        state.selected.clear();
        for (const label of previousSelected) state.selected.add(label);
        throw error;
      }
      return;
    }
    let accepted: boolean;
    try {
      accepted = await state.submit({ answers });
    } catch (error) {
      await this.renderQuestion(state);
      throw error;
    }
    const settled = await this.settleQuestion(
      String(state.rpcId),
      'answered',
      accepted ? '✅ Answer submitted.' : '✅ Answered elsewhere.',
    );
    if (!settled && state.handle !== undefined) {
      await state.adapter.editText(
        state.chatId,
        state.handle.messageId,
        accepted ? '✅ Answer submitted.' : '✅ Answered elsewhere.',
        [],
      );
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
        `${String(session.sessionId) === selected ? '✓' : session.running ? '🟢' : '⚪'} ${sessionTitle(session).slice(0, 52)}`,
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
    stillValid: () => boolean = () => true,
  ): Promise<void> {
    const sessions = await this.control.listSessions();
    if (!sessions.some((session) => String(session.sessionId) === sessionId)) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    // Reading the model directory uses the canonical resume path for dormant sessions.
    await this.control.models(sessionId);
    if (this.disposed || !stillValid()) throw new Error('This session control is no longer active.');
    const key = bindingKey(adapter.id, chatId);
    const previousQuestion = this.pendingQuestions.get(key);
    if (previousQuestion !== undefined) this.clearQuestionCallbacks(previousQuestion);
    this.pendingQuestions.delete(key);
    this.clearQuestionRetry(key);
    this.bindings.set(key, sessionId);
    this.bindingOperators.set(key, senderId);
    this.bindingRevisions.set(key, (this.bindingRevisions.get(key) ?? 0) + 1);
    await this.showDashboard(adapter, chatId, senderId);
    const pending = [...this.questionRequests.values()].find(
      (request) => request.sessionId === sessionId,
    );
    if (pending !== undefined) await this.startQuestionForBinding(key, pending);
  }

  private async showWorkspaces(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    requestedPage: number,
  ): Promise<void> {
    const workspaces = await this.control.listWorkspaces();
    const pages = Math.max(1, Math.ceil(workspaces.length / WORKSPACE_PAGE_SIZE));
    const page = Math.max(0, Math.min(requestedPage, pages - 1));
    const rows = workspaces
      .slice(page * WORKSPACE_PAGE_SIZE, (page + 1) * WORKSPACE_PAGE_SIZE)
      .map((workspace) => [this.button(
        adapter.id,
        chatId,
        senderId,
        truncateLabel(`🗂 ${workspace.title} · ${workspace.path}`, 60),
        { kind: 'create', workspaceId: workspace.workspaceId },
      )]);
    const navigation: { text: string; callbackData: string }[] = [];
    if (page > 0) navigation.push(this.button(
      adapter.id,
      chatId,
      senderId,
      '‹ Previous',
      { kind: 'workspaces', page: page - 1 },
    ));
    if (page + 1 < pages) navigation.push(this.button(
      adapter.id,
      chatId,
      senderId,
      'Next ›',
      { kind: 'workspaces', page: page + 1 },
    ));
    if (navigation.length > 0) rows.push(navigation);
    rows.push([this.button(
      adapter.id,
      chatId,
      senderId,
      'Host default working directory',
      { kind: 'create' },
    )]);
    rows.push([this.button(adapter.id, chatId, senderId, 'Cancel', { kind: 'menu' })]);
    await adapter.sendText(
      chatId,
      workspaces.length === 0
        ? 'No registered workspaces. Create the session in the Host default working directory?'
        : `Choose a workspace for the new session · page ${page + 1}/${pages}`,
      { keyboard: callbackKeyboard(rows) },
    );
  }

  private async createSession(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    workspaceId?: WorkspaceId,
  ): Promise<void> {
    await adapter.sendTyping(chatId);
    const sessionId = await this.control.createSession(workspaceId);
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
    const workspaceTitle = await this.control.workspaceTitle(snapshot.summary.cwd);
    const text = [
      sessionTitle(snapshot.summary),
      '',
      [
        stateTag(state),
        permissionTag(snapshot.permission.current),
        `🧠 ${contextLabel(
          snapshot.context.projectedTokens ?? snapshot.context.pressureTokens,
          snapshot.context.contextWindow,
        )}`,
      ].join('  •  '),
      `${selection.provider}/${selection.model}  •  ${selection.reasoningEffort ?? 'default'}`,
      ...(workspaceTitle === undefined ? [] : [`📁 ${workspaceTitle}`]),
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
    const rows = directory.groups.map((group) => [this.button(
      adapter.id,
      chatId,
      senderId,
      `${directory.current.provider === group.id ? '✓ ' : ''}${truncateLabel(group.name, 44)} · ${group.models.length}`,
      { kind: 'provider-models', sessionId, provider: group.id, page: 0 },
    )]);
    rows.push([this.button(adapter.id, chatId, senderId, 'Back', { kind: 'menu' })]);
    await adapter.sendText(chatId, [
      'Choose a provider',
      '',
      `Current  ${directory.current.provider}/${directory.current.model}`,
    ].join('\n'), { keyboard: callbackKeyboard(rows) });
  }

  private async showProviderModels(
    adapter: MessengerAdapter,
    chatId: string,
    senderId: string,
    sessionId: string,
    provider: string,
    requestedPage: number,
  ): Promise<void> {
    const directory = await this.control.models(sessionId);
    const group = directory.groups.find((candidate) => candidate.id === provider);
    if (group === undefined) throw new Error(`Provider ${provider} is no longer available.`);
    const pages = Math.max(1, Math.ceil(group.models.length / MODEL_PAGE_SIZE));
    const page = Math.max(0, Math.min(requestedPage, pages - 1));
    const rows = group.models
      .slice(page * MODEL_PAGE_SIZE, (page + 1) * MODEL_PAGE_SIZE)
      .map((model) => [this.button(
        adapter.id,
        chatId,
        senderId,
        `${directory.current.provider === group.id && directory.current.model === model.id ? '✓ ' : ''}${truncateLabel(model.name, 50)}`,
        { kind: 'select-model', sessionId, provider: group.id, model: model.id },
      )]);
    const navigation: { text: string; callbackData: string }[] = [];
    if (page > 0) navigation.push(this.button(
      adapter.id,
      chatId,
      senderId,
      '‹ Previous',
      { kind: 'provider-models', sessionId, provider, page: page - 1 },
    ));
    if (page + 1 < pages) navigation.push(this.button(
      adapter.id,
      chatId,
      senderId,
      'Next ›',
      { kind: 'provider-models', sessionId, provider, page: page + 1 },
    ));
    if (navigation.length > 0) rows.push(navigation);
    rows.push([
      this.button(adapter.id, chatId, senderId, 'Providers', { kind: 'models', sessionId }),
      this.button(adapter.id, chatId, senderId, 'Menu', { kind: 'menu' }),
    ]);
    await adapter.sendText(
      chatId,
      `${group.name} · models · ${page + 1}/${pages}`,
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
    const modelIndex = group?.models.findIndex((candidate) => candidate.id === directory.current.model) ?? -1;
    const modelPage = modelIndex < 0 ? 0 : Math.floor(modelIndex / MODEL_PAGE_SIZE);
    const back = group === undefined
      ? { kind: 'models' as const, sessionId }
      : { kind: 'provider-models' as const, sessionId, provider: group.id, page: modelPage };
    if (efforts.length === 0) {
      await adapter.sendText(chatId, [
        `${directory.current.provider}/${directory.current.model}`,
        '',
        'This model uses its provider default reasoning mode.',
      ].join('\n'), {
        keyboard: callbackKeyboard([[
          this.button(adapter.id, chatId, senderId, 'Models', back),
          this.button(adapter.id, chatId, senderId, 'Menu', { kind: 'menu' }),
        ]]),
      });
      return;
    }
    const buttons = [this.button(
      adapter.id,
      chatId,
      senderId,
      `${directory.current.reasoningEffort === undefined ? '✓ ' : ''}Default`,
      { kind: 'select-reasoning', sessionId },
    ), ...efforts.map((effort) => this.button(
      adapter.id,
      chatId,
      senderId,
      `${directory.current.reasoningEffort === effort.id ? '✓ ' : ''}${truncateLabel(effort.name, 26)}`,
      { kind: 'select-reasoning', sessionId, effort: effort.id },
    ))];
    const rows: { text: string; callbackData: string }[][] = [];
    for (let index = 0; index < buttons.length; index += 2) {
      rows.push(buttons.slice(index, index + 2));
    }
    rows.push([
      this.button(adapter.id, chatId, senderId, 'Models', back),
      this.button(adapter.id, chatId, senderId, 'Menu', { kind: 'menu' }),
    ]);
    await adapter.sendText(chatId, [
      'Reasoning',
      `${directory.current.provider}/${directory.current.model}`,
      '',
      `Current  •  ${directory.current.reasoningEffort ?? 'default'}`,
    ].join('\n'), { keyboard: callbackKeyboard(rows) });
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
    ttlMs = CALLBACK_TTL_MS,
  ): { text: string; callbackData: string } {
    this.pruneCallbacks();
    const token = randomUUID().replaceAll('-', '');
    this.callbacks.set(token, {
      transport,
      chatId,
      senderId,
      bindingRevision: this.bindingRevisions.get(bindingKey(transport, chatId)) ?? 0,
      expiresAt: Date.now() + ttlMs,
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
    const thinkingOffset = this.nextThinkingOffset;
    this.nextThinkingOffset = (this.nextThinkingOffset + 1) % THINKING_LABELS.length;
    const state: ProgressState = {
      key,
      adapter,
      chatId,
      sessionId,
      startedAt: Date.now(),
      ready: Promise.resolve(),
      text: '',
      status: [],
      tools: new Map(),
      toolOrder: [],
      phase: 'thinking',
      thinkingOffset,
      animationFrame: 0,
      animationTimer: undefined,
      editTimer: undefined,
      typingTimer: undefined,
      flushInFlight: false,
      flushRequested: false,
      turnEnded: false,
      finalizing: false,
    };
    this.progress.set(key, state);
    const waitingForAnswer = [...this.questionRequests.values()].some(
      (request) => request.sessionId === sessionId,
    );
    if (waitingForAnswer) pushStatus(state, '❓ Waiting for your answer');
    else {
      this.startTyping(state);
      this.startAnimation(state);
    }
    const initialText = progressText(state);
    state.lastRendered = initialText;
    state.ready = adapter.sendText(chatId, initialText, {
      keyboard: callbackKeyboard([[
        this.button(adapter.id, chatId, senderId, 'Cancel', { kind: 'cancel', sessionId }),
      ]]),
    }).then((handle) => {
      state.handle = handle;
      if (progressText(state) !== state.lastRendered) this.scheduleProgressEdits([state]);
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

  private beginProgressForBindings(sessionId: string): void {
    for (const [key, bound] of this.bindings) {
      if (bound !== sessionId) continue;
      const separator = key.indexOf(':');
      const adapter = this.adapters.get(key.slice(0, separator));
      if (adapter === undefined) continue;
      const chatId = key.slice(separator + 1);
      const senderId = this.bindingOperators.get(key) ?? chatId;
      void this.beginProgress(adapter, chatId, senderId, sessionId)
        .catch((error: unknown) => {
          this.ctx.logger.warn(
            'messenger: failed to start progress for one binding: %o',
            error,
          );
        });
    }
  }

  private progressStates(sessionId: string): ProgressState[] {
    return [...this.progress.values()].filter((state) => state.sessionId === sessionId);
  }

  private hasBindings(sessionId: string): boolean {
    return [...this.bindings.values()].includes(sessionId);
  }

  private scheduleProgressEdits(states: readonly ProgressState[]): void {
    for (const state of states) {
      if (state.finalizing || state.handle === undefined || state.editTimer !== undefined) continue;
      state.editTimer = setTimeout(() => {
        state.editTimer = undefined;
        void this.flushProgress(state).catch((error: unknown) => this.logProgressError(error));
      }, PROGRESS_EDIT_INTERVAL_MS);
      state.editTimer.unref?.();
    }
  }

  private async flushProgress(state: ProgressState): Promise<void> {
    if (state.finalizing) return;
    if (state.flushInFlight) {
      state.flushRequested = true;
      return;
    }
    state.flushInFlight = true;
    try {
      do {
        state.flushRequested = false;
        await state.ready;
        if (state.handle === undefined || state.finalizing) return;
        const rendered = progressText(state);
        if (rendered === state.lastRendered) continue;
        const keyboard = state.turnEnded ? [] : undefined;
        await this.enqueueOutbound(state.key, () => state.adapter.editText(
          state.chatId,
          state.handle!.messageId,
          rendered,
          keyboard,
        ));
        state.lastRendered = rendered;
      } while (state.flushRequested && !state.finalizing);
    } finally {
      state.flushInFlight = false;
    }
  }

  private async finalizeProgress(state: ProgressState): Promise<void> {
    state.finalizing = true;
    if (state.editTimer !== undefined) {
      clearTimeout(state.editTimer);
      state.editTimer = undefined;
    }
    this.stopProgressTimers(state);
    try {
      await state.ready;
      const rawFinalText = state.text.trim();
      const sourceFinalText = rawFinalText || progressText(state);
      const finalText = rawFinalText
        ? state.adapter.renderText?.(rawFinalText) ?? rawFinalText
        : sourceFinalText;
      if (state.handle === undefined) {
        await state.adapter.sendText(state.chatId, finalText);
      } else if (state.adapter.replaceText !== undefined) {
        await this.enqueueOutbound(state.key, () => state.adapter.replaceText!(
          state.chatId,
          state.handle!.messageId,
          sourceFinalText,
          [],
        ));
      } else {
        const chunks = state.adapter.splitText?.(finalText) ?? splitTelegramText(finalText);
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
    pushStatus(state, `❌ Could not send prompt: ${this.errorMessage(error)}`);
    state.turnEnded = true;
    await this.finalizeProgress(state);
  }

  private startAnimation(state: ProgressState): void {
    if (state.animationTimer !== undefined || state.turnEnded || state.finalizing) return;
    state.animationTimer = setInterval(() => {
      state.animationFrame += 1;
      void this.flushProgress(state).catch((error: unknown) => this.logProgressError(error));
    }, PROGRESS_ANIMATION_INTERVAL_MS);
    state.animationTimer.unref?.();
  }

  private stopAnimation(state: ProgressState): void {
    if (state.animationTimer === undefined) return;
    clearInterval(state.animationTimer);
    state.animationTimer = undefined;
  }

  private startTyping(state: ProgressState): void {
    if (state.typingTimer !== undefined || state.turnEnded) return;
    void state.adapter.sendTyping(state.chatId).catch((error: unknown) => this.logProgressError(error));
    state.typingTimer = setInterval(() => {
      void state.adapter.sendTyping(state.chatId).catch((error: unknown) => this.logProgressError(error));
    }, TYPING_REFRESH_MS);
    state.typingTimer.unref?.();
  }

  private stopTyping(state: ProgressState): void {
    if (state.typingTimer === undefined) return;
    clearInterval(state.typingTimer);
    state.typingTimer = undefined;
  }

  private stopProgressTimers(state: ProgressState): void {
    this.stopTyping(state);
    this.stopAnimation(state);
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
        () => adapter.sendText(
          key.slice(separator + 1),
          adapter.renderText?.(text) ?? text,
        ),
      ));
    }
    const results = await Promise.allSettled(sends);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.ctx.logger.warn(
          'messenger: failed to deliver assistant text to one binding: %o',
          result.reason,
        );
      }
    }
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
    this.ctx.logger.warn('messenger: progressive transport update failed: %o', error);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
