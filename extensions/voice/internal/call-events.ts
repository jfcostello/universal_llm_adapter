import { LruMap } from '../../../kernel/index.js';

export type VoiceCallEventEnvelope = {
  callConfigId: string;
  atMs: number;
  event: { type: string; [key: string]: any };
};

export type VoiceCallEventSubscription = {
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
    options: { includeDeltas: boolean },
    onEvent: (event: VoiceCallEventEnvelope) => void
  ) => VoiceCallEventSubscription;
  snapshot: () => VoiceCallEventHubSnapshot;
  close: () => void;
};

type Subscriber = {
  includeDeltas: boolean;
  onEvent: (event: VoiceCallEventEnvelope) => void;
};

type Channel = {
  callConfigId: string;
  buffered: VoiceCallEventEnvelope[];
  subscribers: Set<Subscriber>;
  lastActivityAtMs: number;
};

function isDeltaEvent(type: string): boolean {
  return type.endsWith('.delta');
}

export function createVoiceCallEventHub(options?: {
  maxActiveCalls?: number;
  maxBufferedEventsPerCall?: number;
  callTtlMs?: number;
  sweepEveryOps?: number;
  sweepIntervalMs?: number;
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

  let ops = 0;
  const sweepExpired = () => {
    if (callTtlMs <= 0) return;
    const now = Date.now();
    for (const [callConfigId, channel] of channels.entries()) {
      if (channel.subscribers.size > 0) continue;
      if (now - channel.lastActivityAtMs > callTtlMs) {
        channels.delete(callConfigId);
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

  const getOrCreateChannel = (callConfigId: string): Channel => {
    const existing = channels.get(callConfigId);
    if (existing) return existing;
    const channel: Channel = {
      callConfigId,
      buffered: [],
      subscribers: new Set(),
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
    channel.lastActivityAtMs = Date.now();
    channels.set(id, channel); // refresh recency

    const envelope: VoiceCallEventEnvelope = { callConfigId: id, atMs: Date.now(), event };
    const delta = isDeltaEvent(type);

    for (const sub of channel.subscribers) {
      if (delta && !sub.includeDeltas) continue;
      try {
        sub.onEvent(envelope);
      } catch {}
    }

    if (delta) return;
    if (maxBufferedEventsPerCall <= 0) return;

    channel.buffered.push(envelope);
    while (channel.buffered.length > maxBufferedEventsPerCall) {
      channel.buffered.shift();
    }
  };

  const subscribe = (
    callConfigId: string,
    options: { includeDeltas: boolean },
    onEvent: (event: VoiceCallEventEnvelope) => void
  ): VoiceCallEventSubscription => {
    maybeSweep();
    const id = String(callConfigId ?? '').trim();
    if (!id) {
      return {
        replay: [],
        unsubscribe: () => {}
      };
    }

    const channel = getOrCreateChannel(id);
    channel.lastActivityAtMs = Date.now();
    channels.set(id, channel); // refresh recency

    const subscriber: Subscriber = {
      includeDeltas: options.includeDeltas === true,
      onEvent
    };
    channel.subscribers.add(subscriber);

    return {
      replay: channel.buffered.slice(),
      unsubscribe: () => {
        channel.subscribers.delete(subscriber);
      }
    };
  };

  const snapshot = (): VoiceCallEventHubSnapshot => {
    const calls: VoiceCallEventHubSnapshot['calls'] = [];
    let totalSubscribers = 0;
    for (const [callConfigId, channel] of channels.entries()) {
      totalSubscribers += channel.subscribers.size;
      calls.push({ callConfigId, buffered: channel.buffered.length, subscribers: channel.subscribers.size });
    }

    return { activeCalls: channels.size, totalSubscribers, calls };
  };

  const close = () => {
    if (sweepTimer) clearInterval(sweepTimer);
    channels.clear();
  };

  return { emit, subscribe, snapshot, close };
}

