import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import type { MessengerBridge } from '../src/bridge.js';
import { installQuestionAnswerer } from '../src/index.js';

describe('question answerer', () => {
  it('claims an agent-scoped question through the Host waterfall', async () => {
    const answer = { answers: [{ id: 'confirm', selected: ['Continue'] }] };
    const askQuestion = vi.fn(async () => answer);
    let listener: ((request: any, next: () => Promise<any>) => Promise<any>) | undefined;
    const dispose = vi.fn(() => true);
    const on = vi.fn((_event, callback, _options) => {
      listener = callback;
      return dispose;
    });
    const ctx = { on } as unknown as Context;
    const bridge = { askQuestion } as unknown as MessengerBridge;

    expect(installQuestionAnswerer(ctx, bridge)).toBe(dispose);
    expect(on).toHaveBeenCalledWith(
      'user-questions/request',
      expect.any(Function),
      { prepend: true },
    );

    const signal = new AbortController().signal;
    const next = vi.fn(async () => ({ answers: [] }));
    const request = {
      agent: { id: 'session-1' },
      questions: [{ id: 'confirm', question: 'Continue?' }],
      signal,
    };
    await expect(listener?.(request, next)).resolves.toEqual(answer);
    expect(askQuestion).toHaveBeenCalledWith(
      'session-1',
      request.questions,
      signal,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('delegates when the question has no bound Telegram recipient', async () => {
    const askQuestion = vi.fn(async () => undefined);
    let listener: ((request: any, next: () => Promise<any>) => Promise<any>) | undefined;
    const ctx = {
      on: vi.fn((_event, callback) => {
        listener = callback;
        return () => true;
      }),
    } as unknown as Context;
    installQuestionAnswerer(ctx, { askQuestion } as unknown as MessengerBridge);
    const fallback = { answers: [{ id: 'fallback', selected: ['Browser'] }] };
    const next = vi.fn(async () => fallback);

    await expect(listener?.({
      agent: { id: 'session-1' },
      questions: [{ id: 'fallback', question: 'Who answers?' }],
    }, next)).resolves.toEqual(fallback);
    expect(next).toHaveBeenCalledOnce();
  });
});
