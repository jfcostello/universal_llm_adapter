import { DEFAULT_REALTIME_READY_FALLBACK_MS, resolveRealtimeReadyFallbackMs } from '@/kernel/index.ts';

describe('kernel/realtime-ready-fallback', () => {
  test('defaults when unset or invalid', () => {
    expect(resolveRealtimeReadyFallbackMs(undefined)).toBe(DEFAULT_REALTIME_READY_FALLBACK_MS);
    expect(resolveRealtimeReadyFallbackMs({} as any)).toBe(DEFAULT_REALTIME_READY_FALLBACK_MS);
    expect(resolveRealtimeReadyFallbackMs({ handshake: {} } as any)).toBe(DEFAULT_REALTIME_READY_FALLBACK_MS);
    expect(resolveRealtimeReadyFallbackMs({ handshake: { readyFallbackMs: 0 } } as any)).toBe(DEFAULT_REALTIME_READY_FALLBACK_MS);
    expect(resolveRealtimeReadyFallbackMs({ handshake: { readyFallbackMs: -1 } } as any)).toBe(DEFAULT_REALTIME_READY_FALLBACK_MS);
    expect(resolveRealtimeReadyFallbackMs({ handshake: { readyFallbackMs: null } } as any)).toBe(DEFAULT_REALTIME_READY_FALLBACK_MS);
    expect(resolveRealtimeReadyFallbackMs({ handshake: { readyFallbackMs: 'nope' } } as any)).toBe(DEFAULT_REALTIME_READY_FALLBACK_MS);
    expect(resolveRealtimeReadyFallbackMs({ handshake: { readyFallbackMs: Number.POSITIVE_INFINITY } } as any)).toBe(
      DEFAULT_REALTIME_READY_FALLBACK_MS
    );
  });

  test('normalizes to a positive integer', () => {
    expect(resolveRealtimeReadyFallbackMs({ handshake: { readyFallbackMs: 42.9 } } as any)).toBe(42);
    expect(resolveRealtimeReadyFallbackMs({ handshake: { readyFallbackMs: '5' } } as any)).toBe(5);
  });
});

