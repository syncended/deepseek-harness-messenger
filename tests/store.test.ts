import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { BackendRegistry } from '@deepseek-ai/dsh-storage';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { describe, expect, it, vi } from 'vitest';
import {
  DurableMessengerBindingStore,
  messengerBindingDomainSpec,
  messengerBindingIdentity,
  messengerBindingKey,
  messengerBindingRecordSchema,
  type MessengerBindingKey,
  type MessengerBindingRecord,
} from '../src/store.js';

async function openJsonStore(root: string): Promise<{
  readonly store: DurableMessengerBindingStore;
  readonly close: () => Promise<void>;
}> {
  const backend = new JsonStorageBackend(root);
  const registry = new BackendRegistry();
  const unregister = registry.register('json', backend);
  const ctx = {
    storage: { backend: registry },
    emit: vi.fn(),
    logger: { warn: vi.fn() },
  } as unknown as Context;
  const facility = new DomainFacility(ctx, { backend: 'json' });
  const store = await DurableMessengerBindingStore.open({
    storageDomain: facility,
  } as Pick<Context, 'storageDomain'>);
  return {
    store,
    close: async () => {
      await store.close();
      await facility.closeAll();
      unregister();
      await backend.close();
    },
  };
}

describe('messenger binding storage', () => {
  it('uses collision-safe per-user identities', () => {
    expect(messengerBindingKey('a:b', 'c', 'd')).not.toBe(
      messengerBindingKey('a', 'b:c', 'd'),
    );
    const key = messengerBindingKey('telegram', '-100', '42');
    expect(key).toBe(messengerBindingKey('telegram', '-100', '42'));
    expect(key).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(messengerBindingIdentity(key)).toEqual({
      transport: 'telegram',
      chatId: '-100',
      senderId: '42',
    });
  });

  it('validates durable records without accepting empty identities', () => {
    const record = {
      transport: 'telegram',
      chatId: '100',
      chatKind: 'private',
      senderId: '100',
      sessionId: 'session-1',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };

    expect(messengerBindingRecordSchema.parse(record)).toEqual(record);
    expect(() => messengerBindingRecordSchema.parse({
      ...record,
      sessionId: '',
    })).toThrow();
  });

  it('survives JSON backend close/reopen and keeps deletion durable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-messenger-bindings-'));
    const record: MessengerBindingRecord = {
      transport: 'telegram',
      chatId: '-100',
      chatKind: 'group',
      senderId: '42',
      authorizedAs: 'operator',
      sessionId: 'session-1',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    try {
      const first = await openJsonStore(root);
      await first.store.put(record);
      await first.close();

      const second = await openJsonStore(root);
      expect(second.store.list()).toEqual([record]);
      await expect(second.store.delete('telegram', '-100', '42')).resolves.toBe(true);
      await second.close();

      const third = await openJsonStore(root);
      expect(third.store.list()).toEqual([]);
      await third.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('opens one DSH domain and delegates durable put, delete, and close', async () => {
    const records = new Map<MessengerBindingKey, MessengerBindingRecord>();
    const table = {
      entries: vi.fn(() => new Map(records).entries()),
      put: vi.fn(async (key: MessengerBindingKey, value: MessengerBindingRecord) => {
        records.set(key, value);
      }),
      delete: vi.fn(async (key: MessengerBindingKey) => records.delete(key)),
    };
    const close = vi.fn(async () => {});
    const domain = {
      table: vi.fn(() => table),
      close,
    };
    const open = vi.fn(async () => domain);
    const ctx = { storageDomain: { open } } as unknown as Pick<Context, 'storageDomain'>;
    const store = await DurableMessengerBindingStore.open(ctx);
    const record: MessengerBindingRecord = {
      transport: 'telegram',
      chatId: '100',
      chatKind: 'private',
      senderId: '100',
      sessionId: 'session-1',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };

    await store.put(record);
    expect(store.list()).toEqual([record]);
    await expect(store.delete('telegram', '100', '100')).resolves.toBe(true);
    expect(store.list()).toEqual([]);
    await store.close();

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(messengerBindingDomainSpec);
    expect(domain.table).toHaveBeenCalledWith('bindings');
    expect(close).toHaveBeenCalledOnce();
  });
});
