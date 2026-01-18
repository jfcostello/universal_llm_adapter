import { describe, expect, test } from '@jest/globals';

import { Role } from '@/kernel/index.ts';
import { RealtimeObservabilityTracker } from '@/modules/realtime/internal/realtime-session/internal/observability-tracker.ts';

describe('realtime/internal/realtime-session/observability-tracker', () => {
  test('getConversationMessages reflects initial systemPrompt + history', () => {
    const tracker = new RealtimeObservabilityTracker({
      spec: {
        provider: 'test-provider',
        systemPrompt: 'sys',
        history: [{ role: 'user', text: 'hi' }]
      } as any
    });

    expect(tracker.getConversationMessages()).toEqual([
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'sys' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'hi' }] }
    ]);
  });
});
