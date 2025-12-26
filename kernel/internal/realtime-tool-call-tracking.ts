import type { RealtimeSessionSpec } from './realtime-types.js';

export const DEFAULT_REALTIME_TOOL_CALL_TRACKING_MAX_ENTRIES = 1000;

export function resolveRealtimeToolCallTrackingMaxEntries(
  spec: Pick<RealtimeSessionSpec, 'toolCallTracking'> | undefined
): number {
  const raw = (spec as any)?.toolCallTracking?.maxEntries;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_REALTIME_TOOL_CALL_TRACKING_MAX_ENTRIES;
  return Math.floor(n);
}

