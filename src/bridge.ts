import type { Context } from '@deepseek-ai/cordis';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type {
  InboundMessengerMessage,
  MessengerAdapter,
  ParsedCommand,
} from './types.js';

const PLUGIN_NAME = 'messenger';

type BridgeContext = {
  readonly agents: AgentRegistry;
  readonly logger: Context['logger'];
};

export interface MessengerBridgeOptions {
  readonly allowedChatIds: readonly string[];
  readonly allowedUserIds: readonly string[];
  readonly privateChatsOnly: boolean;
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

function textFromAssistantEvent(event: SessionEvent): string | undefined {
  if (
    event.type !== 'assistant/message'
    || event.surfaceOp !== 'append'
    || event.data.interrupted
  ) return undefined;
  const text = event.data.message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
  return text || undefined;
}

function helpText(): string {
  return [
    'DeepSeek Harness messenger bridge',
    '',
    '/sessions — list live DSH chats',
    '/use <session-id> — bind this messenger chat',
    '/status — show the current binding',
    '/steer <text> — steer the active DSH turn',
    '/cancel — cancel the active DSH turn',
    '/unbind — remove the binding',
    '/help — show this help',
    '',
    'Any other text is sent as a follow-up to the bound DSH chat.',
  ].join('\n');
}

export class MessengerBridge {
  private readonly allowedChatIds: ReadonlySet<string>;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly privateChatsOnly: boolean;
  private readonly bindings = new Map<string, string>();
  private readonly adapters = new Map<string, MessengerAdapter>();
  private readonly outboundQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly ctx: BridgeContext,
    options: MessengerBridgeOptions,
  ) {
    this.allowedChatIds = new Set(options.allowedChatIds);
    this.allowedUserIds = new Set(options.allowedUserIds);
    this.privateChatsOnly = options.privateChatsOnly;
  }

  registerAdapter(adapter: MessengerAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Messenger adapter "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  async handle(message: InboundMessengerMessage): Promise<void> {
    const adapter = this.adapters.get(message.transport);
    if (adapter === undefined) {
      throw new Error(`Unknown messenger adapter "${message.transport}"`);
    }
    const isPrivate = message.chatKind === 'private';
    const authorized = this.allowedChatIds.has(message.chatId)
      && (isPrivate
        ? true
        : !this.privateChatsOnly && this.allowedUserIds.has(message.senderId));
    if (!authorized) {
      this.ctx.logger.warn(
        'messenger: ignored unauthorized %s chat %s from user %s',
        message.transport,
        message.chatId,
        message.senderId,
      );
      return;
    }

    const command = parseCommand(message.text);
    if (command !== undefined) {
      await this.handleCommand(adapter, message.chatId, command);
      return;
    }

    const agent = this.boundAgent(message.transport, message.chatId);
    if (agent === undefined) {
      await adapter.sendText(
        message.chatId,
        'This chat is not bound. Use /sessions and /use <session-id>.',
      );
      return;
    }

    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'relay' },
      }),
    );
    await adapter.sendText(message.chatId, `Sent to ${agent.id}.`);
  }

  async onSessionEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const text = textFromAssistantEvent(event);
    if (text === undefined) return;

    const sends: Promise<void>[] = [];
    for (const [key, boundSessionId] of this.bindings) {
      if (boundSessionId !== sessionId) continue;
      const separator = key.indexOf(':');
      const transport = key.slice(0, separator);
      const chatId = key.slice(separator + 1);
      const adapter = this.adapters.get(transport);
      if (adapter !== undefined) {
        sends.push(this.enqueueOutbound(key, () => adapter.sendText(chatId, text)));
      }
    }
    await Promise.all(sends);
  }

  private enqueueOutbound(key: string, send: () => Promise<void>): Promise<void> {
    const previous = this.outboundQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(send);
    this.outboundQueues.set(key, current);
    void current.then(
      () => {
        if (this.outboundQueues.get(key) === current) this.outboundQueues.delete(key);
      },
      () => {
        if (this.outboundQueues.get(key) === current) this.outboundQueues.delete(key);
      },
    );
    return current;
  }

  private boundAgent(transport: string, chatId: string) {
    const sessionId = this.bindings.get(bindingKey(transport, chatId));
    if (sessionId === undefined) return undefined;
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined) {
      this.bindings.delete(bindingKey(transport, chatId));
    }
    return agent;
  }

  private async handleCommand(
    adapter: MessengerAdapter,
    chatId: string,
    command: ParsedCommand,
  ): Promise<void> {
    switch (command.name) {
      case 'start':
      case 'help':
        await adapter.sendText(chatId, helpText());
        return;
      case 'sessions': {
        const agents = this.ctx.agents.roots();
        const text = agents.length === 0
          ? 'No live top-level DSH chats.'
          : agents.map((agent) => `${agent.id} — ${agent.status}`).join('\n');
        await adapter.sendText(chatId, text);
        return;
      }
      case 'use': {
        if (command.argument.length === 0) {
          await adapter.sendText(chatId, 'Usage: /use <session-id>');
          return;
        }
        const agent = this.ctx.agents.roots().find(
          (candidate) => String(candidate.id) === command.argument,
        );
        if (agent === undefined) {
          await adapter.sendText(chatId, `Live top-level DSH chat not found: ${command.argument}`);
          return;
        }
        this.bindings.set(bindingKey(adapter.id, chatId), String(agent.id));
        await adapter.sendText(chatId, `Bound to ${agent.id}.`);
        return;
      }
      case 'status': {
        const agent = this.boundAgent(adapter.id, chatId);
        await adapter.sendText(
          chatId,
          agent === undefined
            ? 'This chat is not bound.'
            : `Bound to ${agent.id}; status: ${agent.status}.`,
        );
        return;
      }
      case 'unbind':
        this.bindings.delete(bindingKey(adapter.id, chatId));
        await adapter.sendText(chatId, 'Binding removed.');
        return;
      case 'cancel': {
        const agent = this.boundAgent(adapter.id, chatId);
        if (agent === undefined) {
          await adapter.sendText(chatId, 'This chat is not bound.');
          return;
        }
        agent.cancel({ kind: 'user' });
        await adapter.sendText(chatId, `Cancellation requested for ${agent.id}.`);
        return;
      }
      case 'steer': {
        const agent = this.boundAgent(adapter.id, chatId);
        if (agent === undefined) {
          await adapter.sendText(chatId, 'This chat is not bound.');
          return;
        }
        if (command.argument.length === 0) {
          await adapter.sendText(chatId, 'Usage: /steer <text>');
          return;
        }
        agent.steer(
          createUserMessage({
            content: [{ type: 'text', text: command.argument }],
            source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'relay' },
          }),
        );
        await adapter.sendText(chatId, `Steering sent to ${agent.id}.`);
        return;
      }
      default:
        await adapter.sendText(chatId, `Unknown command /${command.name}. Use /help.`);
    }
  }
}
