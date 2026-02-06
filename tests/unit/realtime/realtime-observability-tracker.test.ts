import { describe, expect, test, jest } from '@jest/globals';

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

  test('falls back to restrictive shipped defaults when capture fields are missing', () => {
    const observability = {
      exporter: {
        recordLLMRequest: jest.fn(),
        recordLLMResponse: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined)
      },
      baseTraceId: 'trace-123',
      sessionId: 'session-456',
      metadata: { correlationId: 'corr-789' }
      // capture fields intentionally omitted.
    } as any;

    const tracker = new RealtimeObservabilityTracker({
      spec: {
        provider: 'test-provider',
        model: 'test-model',
        systemPrompt: 'sys'
      } as any,
      observability,
      tools: [{ name: 'demo-tool', description: 'demo' }] as any
    });

    tracker.pushTextMessage({ role: Role.USER, text: 'hello' });
    tracker.recordRequest();
    tracker.recordToolCall({ id: 'call-1', name: 'demo-tool', arguments: { api_key: 'secret' } });
    tracker.recordResponse({ content: [{ type: 'text', text: 'response' }] as any });

    const requestArg = (observability.exporter.recordLLMRequest as any).mock.calls[0][0];
    expect(requestArg.messages).toEqual([]);

    const responseArg = (observability.exporter.recordLLMResponse as any).mock.calls[0][0];
    expect(responseArg.content).toEqual([]);
    expect(responseArg.toolCalls).toEqual([{ id: 'call-1', name: 'demo-tool' }]);
  });
});
