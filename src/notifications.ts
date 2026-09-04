import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { MessengerBridge } from './bridge.js';

/** Registered once; resolve the live runtime on every call after reconfiguration. */
export function installNotificationTool(
  ctx: Context,
  getActiveBridges: () => readonly MessengerBridge[],
): () => void {
  return ctx.tools.register(defineTool({
    name: 'messenger_notify',
    description: 'Send an immediate status notification to all authorized chats subscribed with /notifications on on this DSH Host. '
      + 'Works from automation sessions without /resume or any chat-session binding. '
      + 'Includes an Open session button for your current source session; delivery itself never switches the chat. '
      + 'Use for requested automation statuses or useful milestones, not to duplicate final responses or send secrets. '
      + 'Subscriptions are Host-wide and persistent; subscribed groups expose text to all members. '
      + 'No arbitrary recipients or source session IDs. Requires a top-level agent session and an active messenger. '
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
      if (exec.agent.session?.header.origin === 'subagent') {
        throw new Error('Notifications with session buttons must be sent by the top-level agent, not a subagent.');
      }
      const bridges = getActiveBridges();
      if (bridges.length === 0) throw new Error('Messenger is disabled or unavailable.');
      const sessionId = String(exec.agent.id);
      const bound = bridges.filter((bridge) => bridge.canNotify(sessionId));
      if (bound.length === 0) {
        throw new Error('No notification subscribers. Send /notifications on in an allowed bot chat first.');
      }
      const results = await Promise.all(bound.map((bridge) => bridge.notify(sessionId, text, exec.signal)));
      return results.reduce((total, result) => ({
        sent: total.sent + result.sent,
        failed: total.failed + result.failed,
        skipped: total.skipped + result.skipped,
      }), { sent: 0, failed: 0, skipped: 0 });
    },
  }));
}
