import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import type { MessengerBridge } from '../src/bridge.js';
import { installImageTool } from '../src/image-tool.js';
import { IMAGE_BYTE_LIMIT } from '../src/images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function setup() {
  let tool: any;
  const dispose = vi.fn();
  const register = vi.fn((definition) => { tool = definition; return dispose; });
  const sendImage = vi.fn(async () => ({ sent: 1, failed: 0, skipped: 0 }));
  const canSendImage = vi.fn(() => true);
  const imageBindingVersion = vi.fn(() => 'binding-1:revision-1');
  const bridge = { sendImage, canSendImage, imageBindingVersion } as unknown as MessengerBridge;
  let active: readonly MessengerBridge[] = [bridge];
  const target = { targetKey: 'opaque', displayPath: '/workspace/result.png' };
  const resolve = vi.fn(async () => target);
  const stat = vi.fn(async (): Promise<any> => ({ type: 'file', version: 'v1' }));
  const readBytes = vi.fn(async (): Promise<Uint8Array> => png);
  const validateImage = vi.fn(async () => {});
  const imageLimits = { maxImageBytes: IMAGE_BYTE_LIMIT, maxMessageImageBytes: IMAGE_BYTE_LIMIT * 10 };
  const ctx = { tools: { register }, fs: { resolve, stat, readBytes }, attachments: { validateImage, imageLimits } } as unknown as Context;
  const installed = installImageTool(ctx, () => active);
  const controller = new AbortController();
  const exec = { agent: { id: 'session-1', session: { header: { origin: 'user', cwd: '/workspace' } } }, signal: controller.signal };
  return { tool, installed, dispose, register, sendImage, canSendImage, imageBindingVersion, bridge, target, resolve, stat, readBytes,
    validateImage, imageLimits, exec, controller, setActive: (value: readonly MessengerBridge[]) => { active = value; } };
}

describe('messenger_send_image tool', () => {
  it('registers an explicit-path tool and returns a text-only delivery receipt', async () => {
    const s = setup();
    expect(s.installed).toBe(s.dispose);
    expect(s.register).toHaveBeenCalledOnce();
    expect(s.tool.name).toBe('messenger_send_image');
    expect(Object.keys(s.tool.parameters.properties)).toEqual(['file_path']);
    expect(s.tool.parameters.required).toEqual(['file_path']);
    const result = await s.tool.execute({ file_path: 'result.png', sessionId: 'forged', chatId: 'forged' }, s.exec);
    expect(s.resolve).toHaveBeenCalledWith('result.png', { cwd: '/workspace', signal: s.exec.signal });
    expect(s.stat).toHaveBeenCalledWith(s.target, s.exec.signal);
    expect(s.readBytes).toHaveBeenCalledWith(s.target, s.exec.signal, IMAGE_BYTE_LIMIT);
    expect(s.validateImage).toHaveBeenCalledWith({ data: png, mediaType: 'image/png' });
    expect(s.sendImage).toHaveBeenCalledWith('session-1', { bytes: png, mimeType: 'image/png' }, s.exec.signal);
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(s.tool.output.render({}, result)).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
  });

  it('rejects absent agents, subagents, invalid paths and missing session cwd before IO', async () => {
    const s = setup();
    await expect(s.tool.execute({ file_path: 'a.png' }, {})).rejects.toThrow('requires an agent session');
    await expect(s.tool.execute({ file_path: 'a.png' }, { ...s.exec, agent: { id: 'child', session: { header: { origin: 'subagent' } } } }))
      .rejects.toThrow('top-level agent');
    for (const file_path of ['', '  ']) {
      await expect(s.tool.execute({ file_path }, s.exec)).rejects.toThrow('non-empty string');
    }
    for (const file_path of [undefined, 12]) {
      await expect(s.tool.execute({ file_path }, s.exec)).rejects.toThrow('invalid arguments');
    }
    await expect(s.tool.execute({ file_path: 'a.png' }, { ...s.exec, agent: { id: 's', session: { header: {} } } }))
      .rejects.toThrow('workspace directory');
    expect(s.resolve).not.toHaveBeenCalled();
    expect(s.sendImage).not.toHaveBeenCalled();
  });

  it('rejects disabled or unbound runtimes before filesystem access', async () => {
    const s = setup();
    s.setActive([]);
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('disabled or unavailable');
    s.setActive([s.bridge]);
    s.canSendImage.mockReturnValue(false);
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('No authorized messenger chats');
    expect(s.resolve).not.toHaveBeenCalled();
    expect(s.readBytes).not.toHaveBeenCalled();
  });

  it('rejects missing and non-regular targets without reading bytes', async () => {
    const s = setup();
    s.stat.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ type: 'directory' });
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('not found');
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('regular file');
    expect(s.readBytes).not.toHaveBeenCalled();
  });

  it('uses the tighter deployment read bound and propagates backend refusals', async () => {
    const s = setup();
    s.imageLimits.maxMessageImageBytes = 1024;
    s.readBytes.mockRejectedValueOnce(new Error('FS_TOO_LARGE'));
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('FS_TOO_LARGE');
    expect(s.readBytes).toHaveBeenCalledWith(s.target, s.exec.signal, 1024);
    expect(s.validateImage).not.toHaveBeenCalled();
    expect(s.sendImage).not.toHaveBeenCalled();
  });

  it('rejects unsupported signatures, oversized bytes and decoder failures', async () => {
    const s = setup();
    s.readBytes.mockResolvedValueOnce(Buffer.from('not an image'));
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('Unsupported image');
    s.readBytes.mockResolvedValueOnce(new Uint8Array(IMAGE_BYTE_LIMIT + 1));
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('20 MiB');
    s.validateImage.mockRejectedValueOnce(new Error('INVALID_IMAGE'));
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('INVALID_IMAGE');
    expect(s.sendImage).not.toHaveBeenCalled();
  });

  it('does no IO when aborted and does not send after validation cancellation', async () => {
    const s = setup();
    s.controller.abort(new Error('cancelled'));
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('cancelled');
    expect(s.resolve).not.toHaveBeenCalled();
    const later = setup();
    later.validateImage.mockImplementationOnce(async () => { later.controller.abort(new Error('cancelled')); });
    await expect(later.tool.execute({ file_path: 'a.png' }, later.exec)).rejects.toThrow('cancelled');
    expect(later.sendImage).not.toHaveBeenCalled();
  });

  it('rechecks runtime identity and binding after IO', async () => {
    const s = setup();
    s.validateImage.mockImplementationOnce(async () => { s.setActive([]); });
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('binding changed');
    expect(s.sendImage).not.toHaveBeenCalled();
    s.setActive([s.bridge]);
    s.canSendImage.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('binding changed');
    expect(s.sendImage).not.toHaveBeenCalled();
  });

  it.each(['binding-1:revision-3', 'binding-1:revision-1,binding-2:revision-1'])(
    'rejects a changed binding fingerprint %s even when the bridge remains eligible', async (version) => {
      const s = setup();
      s.resolve.mockImplementationOnce(async () => {
        expect(s.imageBindingVersion).toHaveBeenCalledWith('session-1');
        s.imageBindingVersion.mockReturnValue(version);
        return s.target;
      });
      await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('binding changed');
      expect(s.canSendImage).toHaveReturnedWith(true);
      expect(s.imageBindingVersion).toHaveBeenCalledTimes(2);
      expect(s.sendImage).not.toHaveBeenCalled();
    },
  );

  it('aggregates bound bridges without delivering to unbound chats', async () => {
    const s = setup();
    const second = vi.fn(async () => ({ sent: 2, failed: 1, skipped: 1 }));
    const unbound = vi.fn();
    s.setActive([s.bridge, { canSendImage: () => true, imageBindingVersion: () => 'second:1', sendImage: second } as unknown as MessengerBridge,
      { canSendImage: () => false, imageBindingVersion: () => '', sendImage: unbound } as unknown as MessengerBridge]);
    expect(await s.tool.execute({ file_path: 'a.png' }, s.exec)).toEqual({ sent: 3, failed: 1, skipped: 1 });
    expect(unbound).not.toHaveBeenCalled();
    s.sendImage.mockRejectedValueOnce(new Error('delivery failed'));
    await expect(s.tool.execute({ file_path: 'a.png' }, s.exec)).rejects.toThrow('delivery failed');
  });
});
