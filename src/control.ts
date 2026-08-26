import { randomUUID } from 'node:crypto';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api';
import { RpcId, type RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc';
import type {
  ModelProviderGroup,
  ModelSelection,
  SessionModels,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy/api/sessions';
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy/api/workspace';
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';

export interface SessionContextInfo {
  readonly pressureTokens?: number;
  readonly projectedTokens?: number;
  readonly contextWindow?: number;
  readonly systemTokens?: number;
  readonly toolsTokens?: number;
  readonly messageTokens?: number;
  readonly uncachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface PermissionView {
  readonly current: string;
  readonly options: readonly {
    readonly value: string;
    readonly name: string;
    readonly description?: string;
  }[];
}

export interface SessionSnapshot {
  readonly summary: SessionSummary;
  readonly model: SessionModels;
  readonly permission: PermissionView;
  readonly context: SessionContextInfo;
}

type ProjectionValues = {
  readonly title?: string | null;
  readonly permissions?: {
    readonly currentValue?: string;
    readonly options?: readonly {
      readonly value: string;
      readonly name: string;
      readonly description?: string;
    }[];
  };
  readonly contextPressure?: {
    readonly pressureTokens?: number;
    readonly projectedTokens?: number;
    readonly contextWindow?: number;
  };
  readonly contextBreakdown?: {
    readonly systemTokens?: number;
    readonly toolsTokens?: number;
    readonly messageTokens?: number;
  };
  readonly tokenUsage?: {
    readonly uncachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
};

export interface ControlContext {
  readonly agents: AgentRegistry;
  readonly apiProxy: ApiProxy;
  readonly permissionPresets: PermissionPresetService;
}

function request<T>(payload: T): { rpcId: ReturnType<typeof RpcId>; payload: T } {
  return { rpcId: RpcId(`messenger-${randomUUID()}`), payload };
}

function valueOf<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new Error(response.result.error.message);
  return response.result.value;
}

function projectionValues(summary: SessionSummary): ProjectionValues {
  return (summary.projections?.values ?? {}) as ProjectionValues;
}

function contextFrom(values: ProjectionValues): SessionContextInfo {
  return {
    ...values.contextPressure,
    ...values.contextBreakdown,
    ...values.tokenUsage,
  };
}

function permissionFrom(
  values: ProjectionValues,
  service: PermissionPresetService,
): PermissionView {
  const projected = values.permissions;
  const options = projected?.options?.filter((option) => option.value !== 'custom')
    ?? service.names.map((name) => service.optionOf(name));
  return {
    current: projected?.currentValue ?? service.defaultPreset,
    options,
  };
}

export function sessionTitle(summary: SessionSummary): string {
  const title = projectionValues(summary).title?.trim();
  if (title) return title;
  if (summary.cwd) {
    const normalized = summary.cwd.replace(/[\\/]+$/, '');
    const leaf = normalized.split(/[\\/]/).pop();
    if (leaf) return leaf;
  }
  return 'Untitled session';
}

export class DshControl {
  constructor(private readonly ctx: ControlContext) {}

  async listSessions(): Promise<SessionSummary[]> {
    const listed = valueOf(await this.ctx.apiProxy.sessions.list(request({})));
    return listed.items.filter((item) => item.origin !== 'subagent');
  }

  async listWorkspaces(): Promise<WorkspaceView[]> {
    const listed = valueOf(await this.ctx.apiProxy.workspace.list(request({})));
    return listed.items;
  }

  async createSession(workspaceId?: WorkspaceId): Promise<string> {
    const created = valueOf(await this.ctx.apiProxy.sessions.create(request(
      workspaceId === undefined ? {} : { workspaceId },
    )));
    return String(created.sessionId);
  }

  async prompt(sessionId: string, text: string, mode: 'queue' | 'steer'): Promise<void> {
    valueOf(await this.ctx.apiProxy.sessions.prompt(request({
      sessionId: SessionId(sessionId),
      mode,
      content: [{ type: 'text', text }],
    })));
  }

  async models(sessionId: string): Promise<SessionModels> {
    return valueOf(await this.ctx.apiProxy.sessions.models(request({
      sessionId: SessionId(sessionId),
    })));
  }

  async selectModel(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<ModelSelection> {
    const selected = valueOf(await this.ctx.apiProxy.sessions.selectModel(request({
      sessionId: SessionId(sessionId),
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })));
    return selected.selected;
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    const summaries = await this.listSessions();
    const summary = summaries.find((item) => String(item.sessionId) === sessionId);
    if (summary === undefined) throw new Error(`Session ${sessionId} was not found.`);
    const model = await this.models(sessionId);
    const history = valueOf(await this.ctx.apiProxy.sessions.history(request({
      sessionId: SessionId(sessionId),
      maxMessages: 1,
    })));
    const values = (history.projections?.values ?? projectionValues(summary)) as ProjectionValues;
    return {
      summary,
      model,
      permission: permissionFrom(values, this.ctx.permissionPresets),
      context: contextFrom(values),
    };
  }

  async permission(sessionId: string): Promise<PermissionView> {
    const snapshot = await this.snapshot(sessionId);
    return snapshot.permission;
  }

  async setPermission(sessionId: string, preset: string): Promise<void> {
    // `models` resolves/resumes a persisted session through the canonical Host path.
    await this.models(sessionId);
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined) throw new Error(`Session ${sessionId} is not live.`);
    this.ctx.permissionPresets.set(agent.session, preset);
  }

  async cancel(sessionId: string): Promise<boolean> {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined || agent.status !== 'running') return false;
    valueOf(await this.ctx.apiProxy.sessions.cancel(request({
      sessionId: SessionId(sessionId),
    })));
    return true;
  }

  status(sessionId: string): 'running' | 'idle' | 'dormant' {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    return agent?.status ?? 'dormant';
  }

  static groups(models: SessionModels): readonly ModelProviderGroup[] {
    return models.groups;
  }
}

export function visibleAssistantText(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message' || event.surfaceOp !== 'append') return undefined;
  const text = event.data.message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
  return text || undefined;
}
