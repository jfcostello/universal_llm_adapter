import { LruMap } from '../../../kernel/index.js';

export type VoiceCallEventEnvelope = {
  callConfigId: string;
  atMs: number;
  event: { type: string; [key: string]: any };
};

export type VoiceCallEventSubscription = {
  accepted: boolean;
  replay: VoiceCallEventEnvelope[];
  unsubscribe: () => void;
};

export type VoiceCallEventHubSnapshot = {
  activeCalls: number;
  totalSubscribers: number;
  calls: Array<{ callConfigId: string; buffered: number; subscribers: number }>;
};

export type VoiceCallEventHub = {
  emit: (callConfigId: string, event: any) => void;
  subscribe: (
    callConfigId: string,
    options: { includeDeltas: boolean; eventTypes?: string[] },
    onEvent: (event: VoiceCallEventEnvelope) => void
  ) => VoiceCallEventSubscription;
  snapshot: () => VoiceCallEventHubSnapshot;
  close: () => void;
};

type Subscriber = {
  includeDeltas: boolean;
  routes: { kind: 'all' } | { kind: 'types'; eventTypes: string[] };
  onEvent: (event: VoiceCallEventEnvelope) => void;
};

type Channel = {
  callConfigId: string;
  buffered: RingBuffer<VoiceCallEventEnvelope>;
  subscribers: Set<Subscriber>;
  allNoDeltas: Set<Subscriber>;
  allWithDeltas: Set<Subscriber>;
  byTypeNoDeltas: Map<string, Set<Subscriber>>;
  byTypeWithDeltas: Map<string, Set<Subscriber>>;
  lastActivityAtMs: number;
};

function isDeltaEvent(type: string): boolean {
  return type.endsWith('.delta');
}

type RingBuffer<T> = {
  max: number;
  buf?: Array<T | undefined>;
  start: number;
  count: number;
};

function createRingBuffer<T>(max: number): RingBuffer<T> {
  const size = Math.max(0, Math.floor(max));
  // Lazily allocate the backing array on first push to avoid eagerly allocating
  // `maxBufferedEventsPerCall` slots for every call channel.
  return { max: size, start: 0, count: 0 };
}

function ringBufferPush<T>(buffer: RingBuffer<T>, item: T): void {
  if (buffer.max <= 0) return;
  if (!buffer.buf) {
    buffer.buf = new Array(buffer.max);
  }
  const idx = (buffer.start + buffer.count) % buffer.max;
  buffer.buf[idx] = item;
  if (buffer.count < buffer.max) {
    buffer.count += 1;
    return;
  }
  buffer.start = (buffer.start + 1) % buffer.max;
}

function ringBufferToArray<T>(buffer: RingBuffer<T>): T[] {
  if (buffer.count <= 0 || !buffer.buf) return [];
  const out: T[] = [];
  for (let i = 0; i < buffer.count; i += 1) {
    const idx = (buffer.start + i) % buffer.max;
    const v = buffer.buf[idx];
    if (v !== undefined) out.push(v);
  }
  return out;
}

export function createVoiceCallEventHub(options?: {
  maxActiveCalls?: number;
  maxBufferedEventsPerCall?: number;
  callTtlMs?: number;
  sweepEveryOps?: number;
  sweepIntervalMs?: number;
  onSaturation?: (event: { callConfigId: string; maxActiveCalls: number; activeCalls: number }) => void;
  saturationLogIntervalMs?: number;
}): VoiceCallEventHub {
  const maxActiveCalls = (() => {
    const raw = options?.maxActiveCalls;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 20_000;
    return Math.max(1, Math.floor(raw));
  })();

  const maxBufferedEventsPerCall = (() => {
    const raw = options?.maxBufferedEventsPerCall;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 200;
    return Math.max(0, Math.floor(raw));
  })();

  const callTtlMs = (() => {
    const raw = options?.callTtlMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 15 * 60 * 1000;
    return Math.max(0, Math.floor(raw));
  })();

  const sweepEveryOps = (() => {
    const raw = options?.sweepEveryOps;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 250;
    return Math.max(1, Math.floor(raw));
  })();

  const sweepIntervalMs = (() => {
    const raw = options?.sweepIntervalMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    if (raw <= 0) return undefined;
    return Math.max(1, Math.floor(raw));
  })();

  const channels = new LruMap<string, Channel>(maxActiveCalls, { label: 'voice.call_events' });
  const evictableChannels = new LruMap<string, true>(maxActiveCalls, { label: 'voice.call_events.evictable' });

  const saturationLogIntervalMs = (() => {
    const raw = options?.saturationLogIntervalMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1000;
    if (raw <= 0) return 0;
    return Math.floor(raw);
  })();

  let lastSaturationLogAtMs = 0;
  const emitSaturation = (callConfigId: string): void => {
    const handler = options?.onSaturation;
    if (typeof handler !== 'function') return;
    const now = Date.now();
    if (saturationLogIntervalMs > 0 && now - lastSaturationLogAtMs < saturationLogIntervalMs) return;
    lastSaturationLogAtMs = now;
    try {
      handler({ callConfigId, maxActiveCalls, activeCalls: channels.size });
    } catch {}
  };

  let ops = 0;
  const sweepExpired = () => {
    if (callTtlMs <= 0) return;
    const now = Date.now();
    for (const [callConfigId, channel] of channels.entries()) {
      if (channel.subscribers.size > 0) continue;
      if (now - channel.lastActivityAtMs > callTtlMs) {
        channels.delete(callConfigId);
        evictableChannels.delete(callConfigId);
      }
    }
  };

  const maybeSweep = () => {
    ops += 1;
    if (ops % sweepEveryOps !== 0) return;
    sweepExpired();
  };

  const sweepTimer = (() => {
    if (!sweepIntervalMs) return undefined;
    const timer = setInterval(() => sweepExpired(), sweepIntervalMs);
    if (typeof (timer as any)?.unref === 'function') {
      (timer as any).unref();
    }
    return timer;
  })();

  const ensureCapacityForNewChannel = (callConfigId: string): boolean => {
    if (channels.size < maxActiveCalls) return true;

    while (channels.size >= maxActiveCalls) {
      const candidate = evictableChannels.keys().next().value as string | undefined;
      if (!candidate) break;
      evictableChannels.delete(candidate);
      channels.delete(candidate);
    }

    if (channels.size < maxActiveCalls) return true;
    emitSaturation(callConfigId);
    return false;
  };

  const getOrCreateChannel = (callConfigId: string): Channel | undefined => {
    const existing = channels.get(callConfigId);
    if (existing) return existing;
    if (!ensureCapacityForNewChannel(callConfigId)) return undefined;
    const channel: Channel = {
      callConfigId,
      buffered: createRingBuffer(maxBufferedEventsPerCall),
      subscribers: new Set(),
      allNoDeltas: new Set(),
      allWithDeltas: new Set(),
      byTypeNoDeltas: new Map(),
      byTypeWithDeltas: new Map(),
      lastActivityAtMs: Date.now()
    };
    channels.set(callConfigId, channel);
    return channel;
  };

  const emit = (callConfigId: string, event: any) => {
    maybeSweep();
    const id = String(callConfigId ?? '').trim();
    if (!id) return;
    const type = typeof event?.type === 'string' ? event.type : '';
    if (!type) return;

    const channel = getOrCreateChannel(id);
    if (!channel) return;
    channel.lastActivityAtMs = Date.now();
    if (channel.subscribers.size === 0) {
      evictableChannels.set(id, true);
    } else {
      evictableChannels.delete(id);
    }

    const envelope: VoiceCallEventEnvelope = { callConfigId: id, atMs: Date.now(), event };
    const delta = isDeltaEvent(type);

    const send = (sub: Subscriber) => {
      try {
        sub.onEvent(envelope);
      } catch {}
    };

    if (delta) {
      for (const sub of channel.allWithDeltas) send(sub);
      const typed = channel.byTypeWithDeltas.get(type);
      if (typed) for (const sub of typed) send(sub);
    } else {
      for (const sub of channel.allNoDeltas) send(sub);
      for (const sub of channel.allWithDeltas) send(sub);
      const typedNo = channel.byTypeNoDeltas.get(type);
      if (typedNo) for (const sub of typedNo) send(sub);
      const typedYes = channel.byTypeWithDeltas.get(type);
      if (typedYes) for (const sub of typedYes) send(sub);
    }

    if (delta) return;
    ringBufferPush(channel.buffered, envelope);
  };

  const subscribe = (
    callConfigId: string,
    options: { includeDeltas: boolean; eventTypes?: string[] },
    onEvent: (event: VoiceCallEventEnvelope) => void
  ): VoiceCallEventSubscription => {
    maybeSweep();
    const id = String(callConfigId ?? '').trim();
    if (!id) {
      return {
        accepted: false,
        replay: [],
        unsubscribe: () => {}
      };
    }

    const channel = getOrCreateChannel(id);
    if (!channel) {
      return {
        accepted: false,
        replay: [],
        unsubscribe: () => {}
      };
    }
    channel.lastActivityAtMs = Date.now();

    const eventTypes = (() => {
      const raw = options?.eventTypes;
      if (!Array.isArray(raw) || raw.length === 0) return undefined;
      const set = new Set<string>();
      for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (trimmed) set.add(trimmed);
      }
      return set.size > 0 ? Array.from(set) : undefined;
    })();

    const includeDeltas = options.includeDeltas === true;
    const subscriber: Subscriber = {
      includeDeltas,
      routes: eventTypes ? { kind: 'types', eventTypes } : { kind: 'all' },
      onEvent,
    };
    channel.subscribers.add(subscriber);
    evictableChannels.delete(id);

    const replay = (() => {
      const buffered = ringBufferToArray(channel.buffered);
      if (!eventTypes) return buffered;
      const allow = new Set(eventTypes);
      return buffered.filter((evt) => allow.has(evt.event.type));
    })();

    if (subscriber.routes.kind === 'all') {
      if (subscriber.includeDeltas) channel.allWithDeltas.add(subscriber);
      else channel.allNoDeltas.add(subscriber);
    } else {
      const map = subscriber.includeDeltas ? channel.byTypeWithDeltas : channel.byTypeNoDeltas;
      for (const t of subscriber.routes.eventTypes) {
        const existing = map.get(t);
        if (existing) {
          existing.add(subscriber);
          continue;
        }
        map.set(t, new Set([subscriber]));
      }
    }

    return {
      accepted: true,
      replay,
      unsubscribe: () => {
        channel.subscribers.delete(subscriber);

        if (subscriber.routes.kind === 'all') {
          channel.allNoDeltas.delete(subscriber);
          channel.allWithDeltas.delete(subscriber);
        } else {
          const map = subscriber.includeDeltas ? channel.byTypeWithDeltas : channel.byTypeNoDeltas;
          for (const t of subscriber.routes.eventTypes) {
            const set = map.get(t);
            if (!set) continue;
            set.delete(subscriber);
            if (set.size === 0) map.delete(t);
          }
        }

        if (channel.subscribers.size === 0) {
          evictableChannels.set(id, true);
        }
      }
    };
  };

  const snapshot = (): VoiceCallEventHubSnapshot => {
    const calls: VoiceCallEventHubSnapshot['calls'] = [];
    let totalSubscribers = 0;
    for (const [callConfigId, channel] of channels.entries()) {
      totalSubscribers += channel.subscribers.size;
      calls.push({ callConfigId, buffered: channel.buffered.count, subscribers: channel.subscribers.size });
    }

    return { activeCalls: channels.size, totalSubscribers, calls };
  };

  const close = () => {
    if (sweepTimer) clearInterval(sweepTimer);
    channels.clear();
    evictableChannels.clear();
  };

  return { emit, subscribe, snapshot, close };
}
