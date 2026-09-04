import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import type { MessengerBridge } from '../src/bridge.js';
import { installNotificationTool } from '../src/notifications.js';

function setup() {
  let tool: any;
  const dispose = vi.fn();
  const register = vi.fn((definition) => { tool = definition; return dispose; });
  const notify = vi.fn(async () => ({ sent: 1, failed: 0, skipped: 0 }));
  let active: MessengerBridge | undefined = { notify } as unknown as MessengerBridge;
  const ctx = { tools: { register } } as unknown as Context;
  const installed = installNotificationTool(ctx, () => active);
  return { tool, register, notify, dispose, installed, setActive: (value: MessengerBridge | undefined) => { active = value; } };
}

// Capture the real defineTool result: validates the plugin's use of the DSH API.
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
      agent: { id: 'session-1' }, signal,
    });
    expect(notify).toHaveBeenCalledWith('session-1', 'Done', signal);
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(tool.output.render({ text: 'Done' }, result)).toEqual([
      { type: 'text', text: JSON.stringify(result) },
    ]);
  });

  it('rejects calls without an agent or an active runtime', async () => {
    const { tool, notify, setActive } = setup();
    await expect(tool.execute({ text: 'Done' }, {})).rejects.toThrow('requires an agent session');
    setActive(undefined);
    await expect(tool.execute({ text: 'Done' }, { agent: { id: 's' } })).rejects.toThrow('disabled or unavailable');
    expect(notify).not.toHaveBeenCalled();
  });

  it('uses the replacement runtime and never falls back to a parent session', async () => {
    const { tool, notify, setActive } = setup();
    const replacement = vi.fn(async () => ({ sent: 0, failed: 1, skipped: 0 }));
    setActive({ notify: replacement } as unknown as MessengerBridge);
    expect(await tool.execute({ text: 'Done' }, {
      agent: { id: 'child', parent: { id: 'session-1' } },
    })).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(replacement).toHaveBeenCalledWith('child', 'Done', undefined);
    expect(notify).not.toHaveBeenCalled();
  });

  it('propagates missing binding errors instead of claiming delivery', async () => {
    const { tool, notify } = setup();
    notify.mockRejectedValueOnce(new Error('No messenger chat is bound to this session.'));
    await expect(tool.execute({ text: 'Done' }, { agent: { id: 's' } })).rejects.toThrow('No messenger chat');
  });
});
