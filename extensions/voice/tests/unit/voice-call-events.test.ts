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

  test('routes delta events through eventTypes allowlist when includeDeltas=true', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 10, callTtlMs: 0 });

    const received: any[] = [];
    const sub = hub.subscribe('c1', { includeDeltas: true, eventTypes: ['user_transcript.delta'] } as any, (evt) => received.push(evt));

    hub.emit('c1', { type: 'user_transcript.delta', textDelta: 'he' });
    hub.emit('c1', { type: 'user_transcript.final', text: 'hello' });

    expect(received.map(r => r.event.type)).toEqual(['user_transcript.delta']);

    sub.unsubscribe();
    sub.unsubscribe();
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

    const receivedA: any[] = [];
    const receivedB: any[] = [];
    const subA = hub.subscribe('c1', { includeDeltas: true, eventTypes: ['assistant_transcript.final'] } as any, (evt) => receivedA.push(evt));
    const subB = hub.subscribe('c1', { includeDeltas: true, eventTypes: ['assistant_transcript.final'] } as any, (evt) => receivedB.push(evt));

    expect(subA.replay.map(r => r.event.type)).toEqual(['assistant_transcript.final']);
    expect(subB.replay.map(r => r.event.type)).toEqual(['assistant_transcript.final']);

    hub.emit('c1', { type: 'user_transcript.delta', textDelta: 'x' });
    hub.emit('c1', { type: 'assistant_transcript.final', text: 'c' });

    expect(receivedA.map(r => r.event.type)).toEqual(['assistant_transcript.final']);
    expect(receivedB.map(r => r.event.type)).toEqual(['assistant_transcript.final']);

    subA.unsubscribe();
    subB.unsubscribe();
    hub.close();
  });

  test('eventTypes allowlist does not override includeDeltas=false', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 10, callTtlMs: 0 });

    const received: any[] = [];
    const sub = hub.subscribe(
      'c1',
      { includeDeltas: false, eventTypes: ['user_transcript.delta', 'user_transcript.final'] } as any,
      (evt) => received.push(evt)
    );

    hub.emit('c1', { type: 'user_transcript.delta', textDelta: 'he' });
    hub.emit('c1', { type: 'user_transcript.final', text: 'hello' });

    expect(received.map(r => r.event.type)).toEqual(['user_transcript.final']);
    expect(sub.replay.map(r => r.event.type)).toEqual([]);

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

  test('does not evict channels with subscribers when maxActiveCalls is exceeded', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 2, callTtlMs: 0 });

    const received: any[] = [];
    const sub = hub.subscribe('c1', { includeDeltas: false }, (evt) => received.push(evt));

    // Fill capacity with a subscriberless call.
    hub.emit('c2', { type: 'assistant_transcript.final', text: 'b' });
    expect(hub.snapshot().calls.map(c => c.callConfigId).sort()).toEqual(['c1', 'c2']);

    // Exceed capacity with another subscriberless call; should evict c2 (not c1).
    hub.emit('c3', { type: 'assistant_transcript.final', text: 'c' });

    const callIds = hub.snapshot().calls.map(c => c.callConfigId).sort();
    expect(callIds).toEqual(['c1', 'c3']);

    hub.emit('c1', { type: 'assistant_transcript.final', text: 'a' });
    expect(received.map(r => r.event.text)).toEqual(['a']);

    sub.unsubscribe();
    hub.close();
  });

  test('does not create new channels when maxActiveCalls is saturated by subscribed calls', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 1, callTtlMs: 0 });

    const received: any[] = [];
    const sub = hub.subscribe('c1', { includeDeltas: false }, (evt) => received.push(evt));

    hub.emit('c2', { type: 'assistant_transcript.final', text: 'b' });
    expect(hub.snapshot().calls.map(c => c.callConfigId)).toEqual(['c1']);

    hub.emit('c1', { type: 'assistant_transcript.final', text: 'a' });
    expect(received.map(r => r.event.text)).toEqual(['a']);

    sub.unsubscribe();
    hub.close();
  });

  test('invokes onSaturation at most once per interval when maxActiveCalls is saturated', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    try {
      const onSaturation = jest.fn();
      const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 1, callTtlMs: 0, onSaturation, saturationLogIntervalMs: 1000.5 });

      const sub = hub.subscribe('c1', { includeDeltas: false }, () => {});

      const sub2 = hub.subscribe('c2', { includeDeltas: false }, () => {});
      expect(sub2.replay).toEqual([]);

      const sub3 = hub.subscribe('c3', { includeDeltas: false }, () => {});
      expect(sub3.replay).toEqual([]);

      expect(onSaturation).toHaveBeenCalledTimes(1);
      expect(onSaturation.mock.calls[0][0]).toEqual({ callConfigId: 'c2', maxActiveCalls: 1, activeCalls: 1 });

      jest.advanceTimersByTime(1000);
      const sub4 = hub.subscribe('c4', { includeDeltas: false }, () => {});
      expect(sub4.replay).toEqual([]);

      expect(onSaturation).toHaveBeenCalledTimes(2);
      expect(onSaturation.mock.calls[1][0]).toEqual({ callConfigId: 'c4', maxActiveCalls: 1, activeCalls: 1 });

      sub.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
      sub4.unsubscribe();
      hub.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test('disables onSaturation throttling when saturationLogIntervalMs <= 0', async () => {
    const onSaturation = jest.fn();
    const hub = createVoiceCallEventHub({
      maxBufferedEventsPerCall: 10,
      maxActiveCalls: 1,
      callTtlMs: 0,
      onSaturation,
      saturationLogIntervalMs: 0
    });

    const sub = hub.subscribe('c1', { includeDeltas: false }, () => {});

    hub.emit('c2', { type: 'assistant_transcript.final', text: 'b' });
    hub.emit('c3', { type: 'assistant_transcript.final', text: 'c' });

    expect(onSaturation).toHaveBeenCalledTimes(2);
    expect(onSaturation.mock.calls.map(c => c[0].callConfigId)).toEqual(['c2', 'c3']);

    sub.unsubscribe();
    hub.close();
  });

  test('evicts subscriberless channels first when maxActiveCalls is exceeded', async () => {
    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 2, callTtlMs: 0 });

    hub.emit('c1', { type: 'assistant_transcript.final', text: 'a' });
    hub.emit('c2', { type: 'assistant_transcript.final', text: 'b' });
    hub.emit('c3', { type: 'assistant_transcript.final', text: 'c' });

    expect(hub.snapshot().calls.map(c => c.callConfigId).sort()).toEqual(['c2', 'c3']);

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
