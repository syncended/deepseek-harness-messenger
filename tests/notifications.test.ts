import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import type { MessengerBridge } from '../src/bridge.js';
import { installNotificationTool } from '../src/notifications.js';

function setup() {
  let tool: any;
  const dispose = vi.fn();
  const register = vi.fn((definition) => { tool = definition; return dispose; });
  const notify = vi.fn(async () => ({ sent: 1, failed: 0, skipped: 0 }));
  let active: readonly MessengerBridge[] = [{ notify, canNotify: () => true } as unknown as MessengerBridge];
  const ctx = { tools: { register } } as unknown as Context;
  const installed = installNotificationTool(ctx, () => active);
  return { tool, register, notify, dispose, installed, setActive: (value: readonly MessengerBridge[]) => { active = value; } };
}

describe('messenger_notify tool', () => {
  it('registers a text-only tool and returns its lifecycle disposer', async () => {
    const { tool, register, notify, dispose, installed } = setup();
    expect(installed).toBe(dispose);
    expect(register).toHaveBeenCalledOnce();
    expect(tool.name).toBe('messenger_notify');
    expect(Object.keys(tool.parameters.properties)).toEqual(['text']);
    expect(tool.parameters.required).toEqual(['text']);
    const signal = new AbortController().signal;
    const result = await tool.execute({ text: 'Done', sessionId: 'forged', chatId: 'forged' }, {
      agent: { id: 'automation-1', session: { header: { origin: 'automation' } } }, signal,
    });
    expect(notify).toHaveBeenCalledWith('automation-1', 'Done', signal);
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(tool.output.render({ text: 'Done' }, result)).toEqual([
      { type: 'text', text: JSON.stringify(result) },
    ]);
  });

  it('rejects calls without an agent or an active runtime', async () => {
    const { tool, notify, setActive } = setup();
    await expect(tool.execute({ text: 'Done' }, {})).rejects.toThrow('requires an agent session');
    setActive([]);
    await expect(tool.execute({ text: 'Done' }, { agent: { id: 's' } })).rejects.toThrow('disabled or unavailable');
    expect(notify).not.toHaveBeenCalled();
  });

  it('uses the replacement runtime and does not substitute a parent session ID', async () => {
    const { tool, notify, setActive } = setup();
    const replacement = vi.fn(async () => ({ sent: 0, failed: 1, skipped: 0 }));
    setActive([{ notify: replacement, canNotify: () => true } as unknown as MessengerBridge]);
    expect(await tool.execute({ text: 'Done' }, {
      agent: { id: 'source', parent: { id: 'session-1' } },
    })).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(replacement).toHaveBeenCalledWith('source', 'Done', undefined);
    expect(notify).not.toHaveBeenCalled();
  });

  it('rejects durable subagent origins even without a loaded parent', async () => {
    const { tool, notify } = setup();
    await expect(tool.execute({ text: 'Done' }, {
      agent: { id: 'child', session: { header: { origin: 'subagent' } } },
    })).rejects.toThrow('top-level agent');
    expect(notify).not.toHaveBeenCalled();
  });

  it('aggregates eligible bridges and skips runtimes without subscribers', async () => {
    const { tool, setActive } = setup();
    const first = vi.fn(async () => ({ sent: 1, failed: 0, skipped: 0 }));
    const second = vi.fn(async () => ({ sent: 0, failed: 1, skipped: 1 }));
    const empty = vi.fn();
    const makeBridge = (notify: unknown, subscribed: boolean) => ({
      notify, canNotify: () => subscribed,
    } as unknown as MessengerBridge);
    setActive([makeBridge(first, true), makeBridge(second, true), makeBridge(empty, false)]);
    expect(await tool.execute({ text: 'Done' }, { agent: { id: 'automation' } }))
      .toEqual({ sent: 1, failed: 1, skipped: 1 });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(empty).not.toHaveBeenCalled();
    setActive([makeBridge(empty, false)]);
    await expect(tool.execute({ text: 'No' }, { agent: { id: 's' } }))
      .rejects.toThrow('No notification subscribers');
  });

  it('propagates notification failures instead of claiming delivery', async () => {
    const { tool, notify } = setup();
    notify.mockRejectedValueOnce(new Error('No notification subscribers.'));
    await expect(tool.execute({ text: 'Done' }, { agent: { id: 's' } })).rejects.toThrow('No notification subscribers');
  });
});
