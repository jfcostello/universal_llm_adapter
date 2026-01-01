import type { RealtimeSessionSpec } from './realtime-types.js';

export const DEFAULT_REALTIME_READY_FALLBACK_MS = 10_000;

export function resolveRealtimeReadyFallbackMs(
  spec: Pick<RealtimeSessionSpec, 'handshake'> | undefined
): number {
  const raw = (spec as any)?.handshake?.readyFallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REALTIME_READY_FALLBACK_MS;
  return Math.floor(n);
}

