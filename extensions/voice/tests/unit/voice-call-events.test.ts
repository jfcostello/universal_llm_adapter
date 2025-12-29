import { jest } from '@jest/globals';

import { createVoiceCallEventHub } from '../../internal/call-events.js';

describe('extensions/voice: call events hub', () => {
  test('buffers non-delta events and replays to new subscribers', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 2, maxActiveCalls: 10, callTtlMs: 0 });

    hub.emit('c1', { type: 'user_transcript.final', text: 'a' });
    hub.emit('c1', { type: 'assistant_transcript.final', text: 'b' });
    hub.emit('c1', { type: 'assistant_transcript.final', text: 'c' });

    const received: any[] = [];
    const sub = hub.subscribe('c1', { includeDeltas: false }, (evt) => received.push(evt));

    expect(sub.replay.map(r => r.event.text)).toEqual(['b', 'c']);

    hub.emit('c1', { type: 'assistant_transcript.final', text: 'd' });
    expect(received.map(r => r.event.text)).toEqual(['d']);

    sub.unsubscribe();
    hub.close();
  });

  test('does not buffer delta events but forwards them to subscribers when enabled', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 10, callTtlMs: 0 });

    const received: any[] = [];
    const subA = hub.subscribe('c1', { includeDeltas: true }, (evt) => received.push(evt));

    hub.emit('c1', { type: 'user_transcript.delta', textDelta: 'he' });
    hub.emit('c1', { type: 'user_transcript.final', text: 'hello' });

    expect(received.map(r => r.event.type)).toEqual(['user_transcript.delta', 'user_transcript.final']);

    const subB = hub.subscribe('c1', { includeDeltas: true }, () => {});
    expect(subB.replay.map(r => r.event.type)).toEqual(['user_transcript.final']);

    subA.unsubscribe();
    subB.unsubscribe();
    hub.close();
  });

  test('skips delta events for subscribers when includeDeltas=false', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 10, callTtlMs: 0 });

    const received: any[] = [];
    const sub = hub.subscribe('c1', { includeDeltas: false }, (evt) => received.push(evt));

    hub.emit('c1', { type: 'assistant_transcript.delta', textDelta: 'hi' });
    hub.emit('c1', { type: 'assistant_transcript.final', text: 'hi!' });

    expect(received.map(r => r.event.type)).toEqual(['assistant_transcript.final']);

    sub.unsubscribe();
    hub.close();
  });

  test('supports event type allowlist filtering (high-volume)', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 10, callTtlMs: 0 });

    hub.emit('c1', { type: 'user_transcript.final', text: 'a' });
    hub.emit('c1', { type: 'assistant_transcript.final', text: 'b' });

    const received: any[] = [];
    const sub = hub.subscribe('c1', { includeDeltas: true, eventTypes: ['assistant_transcript.final'] } as any, (evt) => received.push(evt));

    expect(sub.replay.map(r => r.event.type)).toEqual(['assistant_transcript.final']);

    hub.emit('c1', { type: 'user_transcript.delta', textDelta: 'x' });
    hub.emit('c1', { type: 'assistant_transcript.final', text: 'c' });

    expect(received.map(r => r.event.type)).toEqual(['assistant_transcript.final']);

    sub.unsubscribe();
    hub.close();
  });

  test('treats invalid eventTypes allowlist as no filter', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 10, callTtlMs: 0 });

    hub.emit('c1', { type: 'user_transcript.final', text: 'a' });
    hub.emit('c1', { type: 'assistant_transcript.final', text: 'b' });

    const received: any[] = [];
    const sub = hub.subscribe('c1', { includeDeltas: true, eventTypes: ['  ', 123 as any] } as any, (evt) => received.push(evt));

    expect(sub.replay.map(r => r.event.type)).toEqual(['user_transcript.final', 'assistant_transcript.final']);

    hub.emit('c1', { type: 'assistant_transcript.final', text: 'c' });
    expect(received.map(r => r.event.type)).toEqual(['assistant_transcript.final']);

    sub.unsubscribe();
    hub.close();
  });

  test('sweeps inactive calls with no subscribers', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    try {
      const hub = createVoiceCallEventHub({ callTtlMs: 1000, sweepIntervalMs: 250, maxActiveCalls: 10 });

      hub.emit('c1', { type: 'user_transcript.final', text: 'a' });
      expect(hub.snapshot().activeCalls).toBe(1);

      jest.advanceTimersByTime(1250);
      expect(hub.snapshot().activeCalls).toBe(0);

      hub.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test('maybeSweep invokes sweepExpired even when callTtlMs <= 0', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 1, maxActiveCalls: 10, callTtlMs: 0, sweepEveryOps: 1 });

    hub.emit('c1', { type: 'user_transcript.final', text: 'a' });
    expect(hub.snapshot().activeCalls).toBe(1);

    hub.close();
  });

  test('treats non-positive sweepIntervalMs as disabled', async () => {
    const hub = createVoiceCallEventHub({ callTtlMs: 1000, sweepIntervalMs: 0 });
    hub.emit('c1', { type: 'user_transcript.final', text: 'a' });
    expect(hub.snapshot().activeCalls).toBe(1);
    hub.close();
  });

  test('does not sweep calls that still have subscribers', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    try {
      const hub = createVoiceCallEventHub({ callTtlMs: 1000, sweepEveryOps: 1, maxActiveCalls: 10 });

      const sub = hub.subscribe('c1', { includeDeltas: false }, () => {});
      expect(hub.snapshot().activeCalls).toBe(1);

      jest.advanceTimersByTime(2000);
      hub.emit('c1', { type: 'user_transcript.final', text: 'a' });
      expect(hub.snapshot().activeCalls).toBe(1);

      sub.unsubscribe();
      hub.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not buffer non-delta events when maxBufferedEventsPerCall=0', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 0, maxActiveCalls: 10, callTtlMs: 0 });

    const received: any[] = [];
    const sub = hub.subscribe('c1', { includeDeltas: false }, (evt) => received.push(evt));

    hub.emit('c1', { type: 'user_transcript.final', text: 'a' });
    expect(received.map(r => r.event.text)).toEqual(['a']);

    const sub2 = hub.subscribe('c1', { includeDeltas: false }, () => {});
    expect(sub2.replay).toEqual([]);

    sub.unsubscribe();
    sub2.unsubscribe();
    hub.close();
  });

  test('handles empty callConfigId and invalid event types safely', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 10, callTtlMs: 0 });

    hub.emit('', { type: 'user_transcript.final', text: 'a' });
    hub.emit(undefined as any, { type: 'user_transcript.final', text: 'a' });
    hub.emit('c1', {});
    hub.emit('c1', { type: '' });

    const received: any[] = [];
    const sub = hub.subscribe('', { includeDeltas: false }, (evt) => received.push(evt));
    expect(sub.replay).toEqual([]);
    expect(typeof sub.unsubscribe).toBe('function');
    sub.unsubscribe();

    const sub2 = hub.subscribe(undefined as any, { includeDeltas: false }, () => {});
    expect(sub2.replay).toEqual([]);
    expect(typeof sub2.unsubscribe).toBe('function');
    sub2.unsubscribe();

    expect(hub.snapshot()).toEqual({ activeCalls: 0, totalSubscribers: 0, calls: [] });

    hub.close();
  });
});
