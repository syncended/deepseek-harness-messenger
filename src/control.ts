import { randomUUID } from 'node:crypto';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type {
  PromptContentPart,
  ModelCatalogFailure,
  ModelProviderGroup,
  ModelSelection,
  SessionSummary,
  SessionController,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller';
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { AssistantImage } from './images.js';
import { decodeImage, IMAGE_BYTE_LIMIT } from './images.js';
import type { MessengerImage } from './types.js';

const NEVER_ABORTED = new AbortController().signal;

export interface SessionModels {
  readonly current: ModelSelection;
  readonly routable: boolean;
  readonly groups: readonly ModelProviderGroup[];
  readonly failures: readonly ModelCatalogFailure[];
}

export interface WorkspaceView {
  readonly workspaceId: WorkspaceId;
  readonly path: string;
  readonly title: string;
  readonly sessionIds: readonly SessionId[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

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
  readonly sessionController: SessionController;
  readonly workspaceRegistry: WorkspaceRegistry;
  readonly permissionPresets: PermissionPresetService;
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
    const listed = await this.ctx.sessionController.list({}, NEVER_ABORTED);
    return listed.items.filter((item) => item.origin !== 'subagent');
  }

  async listWorkspaces(): Promise<WorkspaceView[]> {
    return this.ctx.workspaceRegistry.list().map((workspace) => ({
      workspaceId: workspace.id,
      path: workspace.path,
      title: workspace.title,
      sessionIds: workspace.sessionIds,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    }));
  }

  async workspaceTitle(cwd: string | undefined): Promise<string | undefined> {
    if (cwd === undefined) return undefined;
    const stripped = cwd.replace(/[\\/]+$/, '');
    const normalized = stripped || cwd;
    const workspaces = await this.listWorkspaces();
    const matched = workspaces.find((workspace) => {
      const workspaceStripped = workspace.path.replace(/[\\/]+$/, '');
      return (workspaceStripped || workspace.path) === normalized;
    });
    if (matched?.title.trim()) return matched.title.trim();
    return normalized.split(/[\\/]/).pop() || normalized;
  }

  async createSession(workspaceId?: WorkspaceId): Promise<string> {
    const created = await this.ctx.sessionController.create(
      workspaceId === undefined ? {} : { workspaceId },
    );
    return String(created.sessionId);
  }

  async prompt(sessionId: string, text: string, mode: 'queue' | 'steer', image?: MessengerImage, signal = NEVER_ABORTED): Promise<void> {
    const content: PromptContentPart[] = text ? [{ type: 'text', text }] : [];
    if (image !== undefined) content.push({
      type: 'image', mediaType: image.mimeType, data: Buffer.from(image.bytes).toString('base64'),
    });
    await this.ctx.sessionController.prompt({
      requestId: randomUUID() as SessionRequestId,
      sessionId: SessionId(sessionId),
      mode,
      content,
    }, signal);
  }

  async image(sessionId: string, image: AssistantImage): Promise<MessengerImage> {
    if (!Number.isSafeInteger(image.attachment.bytes) || image.attachment.bytes <= 0 || image.attachment.bytes > IMAGE_BYTE_LIMIT) {
      throw new Error('Response image exceeds messenger limits.');
    }
    const result = await this.ctx.sessionController.attachment({
      sessionId: SessionId(sessionId), attachmentId: image.attachment.attachmentId,
    });
    return decodeImage(result.data);
  }

  async models(sessionId: string): Promise<SessionModels> {
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId));
    if ('error' in resolved) throw resolved.error;
    const catalog = await this.ctx.sessionController.modelCatalog();
    const current = {
      provider: resolved.agent.options.provider ?? catalog.default.provider,
      model: resolved.agent.options.model ?? catalog.default.model,
      ...(resolved.agent.options.reasoningEffort === undefined
        ? catalog.default.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: catalog.default.reasoningEffort }
        : { reasoningEffort: String(resolved.agent.options.reasoningEffort) }),
    };
    return {
      current,
      routable: catalog.routableProviders.includes(current.provider),
      groups: catalog.groups,
      failures: catalog.failures,
    };
  }

  async selectModel(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<ModelSelection> {
    const selected = await this.ctx.sessionController.selectModel({
      sessionId: SessionId(sessionId),
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
    return selected.selected;
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    const model = await this.models(sessionId);
    const summaries = await this.listSessions();
    const summary = summaries.find((item) => String(item.sessionId) === sessionId);
    if (summary === undefined) throw new Error(`Session ${sessionId} was not found.`);
    const values = projectionValues(summary);
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
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId));
    if ('error' in resolved) throw resolved.error;
    this.ctx.permissionPresets.set(resolved.agent.session, preset);
  }

  async cancel(sessionId: string): Promise<boolean> {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined || agent.status !== 'running') return false;
    await this.ctx.sessionController.cancel({
      sessionId: SessionId(sessionId),
    });
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
