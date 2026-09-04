import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { MessengerBridge } from './bridge.js';

/** Registered once; resolve the live runtime on every call after reconfiguration. */
export function installNotificationTool(
  ctx: Context,
  getActiveBridge: () => MessengerBridge | undefined,
): () => void {
  return ctx.tools.register(defineTool({
    name: 'messenger_notify',
    description: 'Send an immediate, standalone notification to all messenger chats bound to your current session. '
      + 'Use for requested notifications or useful milestones, not to duplicate final responses or send secrets. '
      + 'Bound groups expose the text to all members. No arbitrary recipients or parent-session fallback. '
      + 'Requires an active messenger and a binding created with /resume or /new. '
      + 'Reports accepted, failed, and skipped chat counts (not read receipts). '
      + 'Failures may include partially delivered messages; do not blindly retry. '
      + 'Does not schedule delivery or wait for a reply; use ask_user_question for questions.',
    parameters: {
      text: { type: 'string', required: true, description: 'Notification text: non-blank, at most 16000 characters. Markdown is supported.' },
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
    async execute({ text }, exec) {
      if (exec.agent === undefined) throw new Error('messenger_notify requires an agent session.');
      const bridge = getActiveBridge();
      if (bridge === undefined) throw new Error('Messenger is disabled or unavailable.');
      return bridge.notify(String(exec.agent.id), text, exec.signal);
    },
  }));
}
