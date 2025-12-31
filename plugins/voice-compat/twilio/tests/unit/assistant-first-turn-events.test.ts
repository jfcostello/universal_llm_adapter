import { jest } from '@jest/globals';

import { wrapAssistantFirstTurnEvents } from '../../internal/assistant-first-turn-events.ts';

describe('plugins/voice-compat/twilio: assistant-first-turn events wrapper', () => {
  test('returns done when the upstream session ends before emitting any events', async () => {
    const onReady = jest.fn();
    const events = wrapAssistantFirstTurnEvents({
      originalEvents: async function* () {},
      onReady
    });

    const it = events()[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
  });

  test('returns done when the upstream session yields a nullish first event', async () => {
    const onReady = jest.fn();
    const events = wrapAssistantFirstTurnEvents({
      originalEvents: async function* () {
        yield null as any;
      },
      onReady
    });

    const it = events()[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
  });

  test('forwards ready and triggers onReady after the first yield resumes', async () => {
    const onReady = jest.fn();
    const events = wrapAssistantFirstTurnEvents({
      originalEvents: async function* () {
        yield { type: 'ready', sessionId: 's1' };
        yield { type: 'after_ready' };
      },
      onReady
    });

    const it = events()[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first).toEqual({ done: false, value: { type: 'ready', sessionId: 's1' } });
    expect(onReady).not.toHaveBeenCalled();

    const second = await it.next();
    expect(second).toEqual({ done: false, value: { type: 'after_ready' } });
    expect(onReady).toHaveBeenCalledTimes(1);

    const third = await it.next();
    expect(third.done).toBe(true);
  });

  test('forwards events but does not trigger onReady when ready is never emitted', async () => {
    const onReady = jest.fn();
    const events = wrapAssistantFirstTurnEvents({
      originalEvents: async function* () {
        yield { type: 'not_ready' };
        yield { type: 'after_not_ready' };
      },
      onReady
    });

    const it = events()[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: 'not_ready' });
    expect((await it.next()).value).toEqual({ type: 'after_not_ready' });
    expect((await it.next()).done).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
  });

  test('triggers onReady after yielding ready when ready is not the first event', async () => {
    const onReady = jest.fn();
    const events = wrapAssistantFirstTurnEvents({
      originalEvents: async function* () {
        yield { type: 'prelude' };
        yield { type: 'ready', sessionId: 's1' };
        yield { type: 'after_ready' };
      },
      onReady
    });

    const it = events()[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first).toEqual({ done: false, value: { type: 'prelude' } });
    expect(onReady).not.toHaveBeenCalled();

    const second = await it.next();
    expect(second).toEqual({ done: false, value: { type: 'ready', sessionId: 's1' } });
    expect(onReady).not.toHaveBeenCalled();

    const third = await it.next();
    expect(third).toEqual({ done: false, value: { type: 'after_ready' } });
    expect(onReady).toHaveBeenCalledTimes(1);

    const fourth = await it.next();
    expect(fourth.done).toBe(true);
  });
});
