import { DEFAULT_REALTIME_TOOL_CALL_TRACKING_MAX_ENTRIES, resolveRealtimeToolCallTrackingMaxEntries } from '@/modules/kernel/index.ts';

describe('kernel/realtime-tool-call-tracking', () => {
  test('defaults when unset or invalid', () => {
    expect(resolveRealtimeToolCallTrackingMaxEntries(undefined)).toBe(DEFAULT_REALTIME_TOOL_CALL_TRACKING_MAX_ENTRIES);
    expect(resolveRealtimeToolCallTrackingMaxEntries({ toolCallTracking: {} } as any)).toBe(DEFAULT_REALTIME_TOOL_CALL_TRACKING_MAX_ENTRIES);
    expect(resolveRealtimeToolCallTrackingMaxEntries({ toolCallTracking: { maxEntries: 0 } } as any)).toBe(DEFAULT_REALTIME_TOOL_CALL_TRACKING_MAX_ENTRIES);
    expect(resolveRealtimeToolCallTrackingMaxEntries({ toolCallTracking: { maxEntries: -1 } } as any)).toBe(DEFAULT_REALTIME_TOOL_CALL_TRACKING_MAX_ENTRIES);
    expect(resolveRealtimeToolCallTrackingMaxEntries({ toolCallTracking: { maxEntries: 'nope' } } as any)).toBe(DEFAULT_REALTIME_TOOL_CALL_TRACKING_MAX_ENTRIES);
  });

  test('normalizes to an integer >= 1', () => {
    expect(resolveRealtimeToolCallTrackingMaxEntries({ toolCallTracking: { maxEntries: 42.9 } } as any)).toBe(42);
    expect(resolveRealtimeToolCallTrackingMaxEntries({ toolCallTracking: { maxEntries: '5' } } as any)).toBe(5);
  });
});

