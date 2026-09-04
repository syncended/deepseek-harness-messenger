import { describe, expect, it } from 'vitest';
import {
  NotificationStore,
  NOTIFICATION_LINK_TTL_MS,
  MAX_NOTIFICATION_LINKS,
  type NotificationState,
} from '../src/notification-store.js';
import type { InboundTextMessage } from '../src/types.js';

const empty = (): NotificationState => ({ subscriptions: [], links: [] });
const message = (overrides: Partial<InboundTextMessage> = {}): InboundTextMessage => ({
  kind: 'message', transport: 'telegram', chatId: 'chat', senderId: 'operator',
  messageId: 'message', text: '/notifications on', ...overrides,
});

function fixture() {
  let persisted = empty();
  let time = 1000;
  const save = async (state: NotificationState) => { persisted = structuredClone(state); };
  const store = new NotificationStore(persisted, save, () => time);
  return { store, save, persisted: () => persisted, advance: (ms: number) => { time += ms; } };
}

describe('NotificationStore', () => {
  it('restores subscriptions and reusable opaque links without message text', async () => {
    const f = fixture();
    const sub = await f.store.subscribe(message({ senderAliases: ['alias'], chatKind: 'private' }));
    const token = await f.store.createLink(sub, 'session-secret');
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(token).not.toContain('session-secret');
    const restored = new NotificationStore(f.persisted(), f.save, () => 1000);
    expect(restored.get('telegram', 'chat')).toEqual(sub);
    expect(restored.list('other-transport')).toEqual([]);
    expect(restored.link(token)?.sessionId).toBe('session-secret');
    expect(restored.link(token)).toEqual(restored.link(token));
    expect(JSON.stringify(f.persisted())).not.toContain('/notifications on');
    expect(JSON.stringify(f.persisted())).not.toContain('messageId');
  });

  it('preserves same-owner identity and invalidates links after replacement or unsubscribe', async () => {
    const { store } = fixture();
    const original = await store.subscribe(message());
    const token = await store.createLink(original, 's1');
    const repeated = await store.subscribe(message({ senderAliases: ['new-alias'] }));
    expect(repeated.id).toBe(original.id);
    expect(store.link(token)).toBeDefined();
    const replacement = await store.subscribe(message({ senderId: 'other' }));
    expect(replacement.id).not.toBe(original.id);
    expect(store.link(token)).toBeUndefined();
    await expect(store.createLink(original, 's2')).rejects.toThrow('no longer current');
    const replacementToken = await store.createLink(replacement, 's3');
    await store.unsubscribe('telegram', 'chat');
    expect(store.link(replacementToken)).toBeUndefined();
    expect(store.list('telegram')).toEqual([]);
    await store.unsubscribe('telegram', 'chat');
  });

  it('scopes identical chat IDs to transport and expires links at exactly 30 days', async () => {
    const f = fixture();
    const sub = await f.store.subscribe(message());
    await f.store.subscribe(message({ transport: 'other-transport' }));
    const token = await f.store.createLink(sub, 's');
    f.advance(NOTIFICATION_LINK_TTL_MS - 1);
    expect(f.store.link(token)).toBeDefined();
    f.advance(1);
    expect(f.store.link(token)).toBeUndefined();
    await f.store.unsubscribe('telegram', 'chat');
    expect(f.store.list('other-transport')).toHaveLength(1);
    expect(f.persisted().links).toEqual([]);
  });

  it('evicts oldest links above the persisted 4096 record bound', async () => {
    const f = fixture();
    const sub = await f.store.subscribe(message());
    const initial = f.persisted();
    initial.links = Array.from({ length: MAX_NOTIFICATION_LINKS }, (_, i) => ({
      token: `old-${i}`, subscriptionId: sub.id, transport: sub.transport,
      chatId: sub.chatId, senderId: sub.senderId, sessionId: `session-${i}`,
      expiresAt: 1000 + NOTIFICATION_LINK_TTL_MS,
    }));
    const store = new NotificationStore(initial, f.save, () => 1000);
    const token = await store.createLink(sub, 'new-session');
    expect(store.link('old-0')).toBeUndefined();
    expect(store.link('old-1')).toBeDefined();
    expect(store.link(token)).toBeDefined();
    expect(f.persisted().links).toHaveLength(MAX_NOTIFICATION_LINKS);
  });

  it('serializes compound mutations and publishes nothing before durability', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const snapshots: NotificationState[] = [];
    const store = new NotificationStore(empty(), async (state) => {
      calls++;
      if (calls === 1) await gate;
      snapshots.push(state);
    });
    const first = store.subscribe(message());
    const second = store.subscribe(message({ chatId: 'second' }));
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(store.list('telegram')).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(store.list('telegram')).toHaveLength(2);
    expect(snapshots.map((s) => s.subscriptions.length)).toEqual([1, 2]);
  });

  it('close immediately rejects late mutations and drains previously accepted work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new NotificationStore(empty(), async () => { await gate; });
    const accepted = store.subscribe(message());
    let finished = false;
    const closing = store.close().then(() => { finished = true; });
    await expect(store.subscribe(message({ chatId: 'late' }))).rejects.toThrow('closed');
    expect(finished).toBe(false);
    release();
    await accepted;
    await closing;
    await store.close();
    expect(store.list('telegram')).toHaveLength(1);
    await expect(store.unsubscribe('telegram', 'chat')).rejects.toThrow('closed');
  });

  it('keeps memory unchanged on failed writes and allows later operations', async () => {
    let failing = false;
    const store = new NotificationStore(empty(), async () => {
      if (failing) throw new Error('disk failed');
    });
    const sub = await store.subscribe(message());
    const token = await store.createLink(sub, 's');
    failing = true;
    await expect(store.unsubscribe('telegram', 'chat')).rejects.toThrow('disk failed');
    expect(store.get('telegram', 'chat')).toEqual(sub);
    expect(store.link(token)).toBeDefined();
    failing = false;
    await store.unsubscribe('telegram', 'chat');
    expect(store.get('telegram', 'chat')).toBeUndefined();
  });

  it('defensively clones values and rejects malformed or cross-owned persisted state', async () => {
    const f = fixture();
    const sub = await f.store.subscribe(message({ senderAliases: ['alias'] }));
    sub.senderId = 'mutated';
    const listed = f.store.list('telegram');
    listed[0]!.senderId = 'also-mutated';
    expect(f.store.get('telegram', 'chat')?.senderId).toBe('operator');
    expect(() => new NotificationStore({ subscriptions: [], links: [], text: 'secret' }, f.save)).toThrow();
    const valid = f.persisted();
    expect(() => new NotificationStore({ ...valid, subscriptions: [...valid.subscriptions, ...valid.subscriptions] }, f.save)).toThrow();
    const owner = f.store.get('telegram', 'chat')!;
    const token = await f.store.createLink(owner, 's');
    const link = f.store.link(token)!;
    link.senderId = 'modified';
    expect(f.store.link(token)?.senderId).toBe('operator');
    const invalid = f.persisted();
    invalid.links[0]!.senderId = 'other';
    expect(() => new NotificationStore(invalid, f.save)).toThrow();
  });
});
