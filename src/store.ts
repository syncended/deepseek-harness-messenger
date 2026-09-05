import { Buffer } from 'node:buffer';
import type { Context } from '@deepseek-ai/cordis';
import {
  defineDomain,
  domainTable,
  type Domain,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { MessengerChatKind } from './types.js';

const messengerChatKindSchema = z.enum([
  'private',
  'group',
  'supergroup',
  'channel',
]);

export const messengerBindingRecordSchema = z.object({
  transport: z.string().min(1),
  chatId: z.string().min(1),
  chatKind: messengerChatKindSchema.optional(),
  senderId: z.string().min(1),
  authorizedAs: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  sessionCwd: z.string().min(1).optional(),
  updatedAt: z.string().min(1),
});

export interface MessengerBindingRecord {
  readonly transport: string;
  readonly chatId: string;
  readonly chatKind?: MessengerChatKind | undefined;
  readonly senderId: string;
  readonly authorizedAs?: string | undefined;
  readonly sessionId: string;
  readonly sessionCwd?: string | undefined;
  readonly updatedAt: string;
}

export type MessengerBindingKey = string & {
  readonly __messengerBindingKey: unique symbol;
};

export const messengerBindingDomainSpec = defineDomain({
  name: 'messenger_bindings',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    bindings: domainTable<MessengerBindingKey, MessengerBindingRecord>(
      messengerBindingRecordSchema,
    ),
  },
});

export interface MessengerBindingIdentity {
  readonly transport: string;
  readonly chatId: string;
  readonly senderId: string;
}

export function messengerBindingKey(
  transport: string,
  chatId: string,
  senderId: string,
): MessengerBindingKey {
  const encoded = Buffer.from(
    JSON.stringify([transport, chatId, senderId]),
    'utf8',
  ).toString('base64url');
  return `v1_${encoded}` as MessengerBindingKey;
}

export function messengerBindingIdentity(key: string): MessengerBindingIdentity {
  if (!key.startsWith('v1_')) throw new Error('Invalid messenger binding identity.');
  const encoded = key.slice(3);
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  const parsed: unknown = JSON.parse(decoded);
  if (
    !Array.isArray(parsed)
    || parsed.length !== 3
    || parsed.some((part) => typeof part !== 'string' || part.length === 0)
  ) throw new Error('Invalid messenger binding identity.');
  const [transport, chatId, senderId] = parsed as [string, string, string];
  if (messengerBindingKey(transport, chatId, senderId) !== key) {
    throw new Error('Invalid messenger binding identity.');
  }
  return { transport, chatId, senderId };
}

export interface MessengerBindingStore {
  list(): readonly MessengerBindingRecord[];
  put(record: MessengerBindingRecord): Promise<void>;
  delete(transport: string, chatId: string, senderId: string): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryMessengerBindingStore implements MessengerBindingStore {
  private readonly records = new Map<MessengerBindingKey, MessengerBindingRecord>();

  constructor(records: readonly MessengerBindingRecord[] = []) {
    for (const record of records) {
      this.records.set(
        messengerBindingKey(record.transport, record.chatId, record.senderId),
        record,
      );
    }
  }

  list(): readonly MessengerBindingRecord[] {
    return [...this.records.values()];
  }

  async put(record: MessengerBindingRecord): Promise<void> {
    this.records.set(
      messengerBindingKey(record.transport, record.chatId, record.senderId),
      record,
    );
  }

  async delete(
    transport: string,
    chatId: string,
    senderId: string,
  ): Promise<boolean> {
    return this.records.delete(messengerBindingKey(transport, chatId, senderId));
  }

  async close(): Promise<void> {}
}

export class DurableMessengerBindingStore implements MessengerBindingStore {
  private constructor(
    private readonly domain: Domain<typeof messengerBindingDomainSpec>,
    private readonly table: KvTable<MessengerBindingKey, MessengerBindingRecord>,
  ) {}

  static async open(
    ctx: Pick<Context, 'storageDomain'>,
  ): Promise<DurableMessengerBindingStore> {
    const domain = await ctx.storageDomain.open(messengerBindingDomainSpec);
    return new DurableMessengerBindingStore(domain, domain.table('bindings'));
  }

  list(): readonly MessengerBindingRecord[] {
    return [...this.table.entries()].map(([, record]) => record);
  }

  async put(record: MessengerBindingRecord): Promise<void> {
    await this.table.put(
      messengerBindingKey(record.transport, record.chatId, record.senderId),
      record,
    );
  }

  delete(transport: string, chatId: string, senderId: string): Promise<boolean> {
    return this.table.delete(messengerBindingKey(transport, chatId, senderId));
  }

  close(): Promise<void> {
    return this.domain.close();
  }
}
