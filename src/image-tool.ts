import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { MessengerBridge } from './bridge.js';
import { IMAGE_BYTE_LIMIT, messengerImage } from './images.js';

/** Explicit file export only; never infer image uploads from assistant Markdown. */
export function installImageTool(
  ctx: Context,
  getActiveBridges: () => readonly MessengerBridge[],
): () => void {
  return ctx.tools.register(defineTool({
    name: 'messenger_send_image',
    description: 'Send a local PNG/JPEG/WebP/GIF image to authorized messenger chats currently bound to your session. '
      + 'Use only when the user requested or needs delivery of an image, not merely to inspect it. '
      + 'This exports file contents outside the Host: never send secrets or unrelated private images. '
      + 'Filesystem read access does not itself authorize export; every sandbox mode may permit reads. '
      + 'Requires a top-level agent session and a bound chat. No arbitrary recipients or session IDs. '
      + 'Reads at most 20 MiB through the filesystem backend and validates the image before sending. '
      + 'Reports accepted, failed, and skipped chat counts, not read receipts; partial delivery is possible, so do not blindly retry.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Explicit path of the image to deliver, resolved relative to this session workspace by the filesystem backend.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute({ file_path }, exec) {
      if (exec.agent === undefined) throw new Error('messenger_send_image requires an agent session.');
      if (exec.agent.session?.header.origin === 'subagent') {
        throw new Error('Images must be sent by the top-level agent, not a subagent.');
      }
      if (typeof file_path !== 'string' || !file_path.trim()) throw new Error('file_path must be a non-empty string.');
      const cwd = exec.agent.session?.header.cwd;
      if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('The agent session has no workspace directory.');
      const sessionId = String(exec.agent.id);
      const bridges = getActiveBridges();
      if (bridges.length === 0) throw new Error('Messenger is disabled or unavailable.');
      const bound = bridges.filter((bridge) => bridge.canSendImage(sessionId))
        .map((bridge) => ({ bridge, version: bridge.imageBindingVersion(sessionId) }));
      if (bound.length === 0) throw new Error('No authorized messenger chats are bound to this session.');
      exec.signal.throwIfAborted();
      const target = await ctx.fs.resolve(file_path, { cwd, signal: exec.signal });
      const info = await ctx.fs.stat(target, exec.signal);
      if (info === undefined) throw new Error('Image file was not found.');
      if (info.type !== 'file') throw new Error('Image path must identify a regular file.');
      const byteLimit = Math.min(IMAGE_BYTE_LIMIT, ctx.attachments.imageLimits.maxImageBytes,
        ctx.attachments.imageLimits.maxMessageImageBytes);
      const image = messengerImage(await ctx.fs.readBytes(target, exec.signal, byteLimit));
      exec.signal.throwIfAborted();
      await ctx.attachments.validateImage({ data: image.bytes, mediaType: image.mimeType });
      exec.signal.throwIfAborted();
      // A reconfigured runtime or changed binding must not inherit an in-flight export.
      const current = getActiveBridges();
      const eligible = bound.filter(({ bridge, version }) => current.includes(bridge)
        && bridge.canSendImage(sessionId) && bridge.imageBindingVersion(sessionId) === version);
      if (eligible.length === 0) throw new Error('The messenger binding changed before the image could be sent.');
      const results = await Promise.all(eligible.map(({ bridge }) => bridge.sendImage(sessionId, image, exec.signal)));
      return results.reduce((total, result) => ({
        sent: total.sent + result.sent,
        failed: total.failed + result.failed,
        skipped: total.skipped + result.skipped,
      }), { sent: 0, failed: 0, skipped: 0 });
    },
  }));
}
