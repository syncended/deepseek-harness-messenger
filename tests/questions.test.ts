import type { Context } from '@deepseek-ai/cordis';
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api';
import { describe, expect, it, vi } from 'vitest';
import type { MessengerBridge } from '../src/bridge.js';
import { mirrorQuestionEvents } from '../src/index.js';

describe('question event stream', () => {
  it('reconnects after a stream error and receives replayed pending questions', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const requested = vi.fn(async () => {
        controller.abort();
      });
      const bridge = {
        onQuestionRequested: requested,
        onQuestionResolved: vi.fn(),
      } as unknown as MessengerBridge;
      const streams = [
        async function* () {
          yield {
            rpcId: RpcId('stream-error'),
            payload: {
              type: 'stream/error' as const,
              error: { code: 'internal' as const, message: 'temporary', details: {} },
            },
          };
        },
        async function* () {
          yield {
            rpcId: RpcId('question-rpc'),
            payload: {
              type: 'question/requested' as const,
              sessionId: 'session-1',
              questions: [{ id: 'confirm', question: 'Continue?' }],
            },
          };
        },
      ];
      const mux = vi.fn(() => streams.shift()!());
      const ctx = {
        apiProxy: { events: { mux } },
        logger: { warn: vi.fn() },
      } as unknown as Context;

      const running = mirrorQuestionEvents(ctx, bridge, controller.signal);
      await vi.waitFor(() => expect(mux).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(250);
      await running;

      expect(mux).toHaveBeenCalledTimes(2);
      expect(requested).toHaveBeenCalledWith(
        'question-rpc',
        'session-1',
        [{ id: 'confirm', question: 'Continue?' }],
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
