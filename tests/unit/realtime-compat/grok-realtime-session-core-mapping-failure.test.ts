import { jest } from '@jest/globals';

import type { RealtimeEvent } from '@/kernel/index.ts';
import { AsyncQueue } from '@/kernel/index.ts';

type TransportEvent =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'error'; error: unknown; code?: string }
  | { type: 'close' };

async function waitForEvent<T extends RealtimeEvent = RealtimeEvent>(
  iter: AsyncIterator<RealtimeEvent>,
  predicate: (value: RealtimeEvent) => boolean,
  timeoutMs = 2000
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const next = await iter.next();
    if (next.done) throw new Error('session events closed');
    if (predicate(next.value as any)) return next.value as any;
  }
  throw new Error('timed out waiting for event');
}

describe('realtime-compat/grok — session core mapping failure', () => {
  test('maps event-mapper failures into normalized error events', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('@/plugins/realtime-compat/grok/internal/event-mapper.ts', () => ({
        __esModule: true,
        mapGrokRealtimeServerEvent: () => {
          throw new Error('map boom');
        }
      }));

      const { createGrokRealtimeCompatSessionWithTransport } = await import('@/plugins/realtime-compat/grok/internal/session-core.ts');

      const q = new AsyncQueue<TransportEvent>();
      const sent: any[] = [];
      const transport = {
        send: (data: string) => {
          sent.push(JSON.parse(String(data)));
        },
        events: () => q.iterate(),
        close: () => {
          q.push({ type: 'close' });
          q.close();
        }
      };

      const session = createGrokRealtimeCompatSessionWithTransport(
        {
          provider: {
            id: 'grok',
            compat: 'grok',
            endpoint: { urlTemplate: 'wss://x', headers: {} },
            metadata: { defaultVoice: 'ara' }
          } as any,
          spec: { provider: 'grok' } as any
        },
        transport as any
      );

      const it = session.events()[Symbol.asyncIterator]();

      q.push({ type: 'open' });
      q.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });

      // Mapping failure BEFORE ready should be buffered and flushed after ready.
      q.push({ type: 'message', data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
      q.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
      await waitForEvent(it, e => e.type === 'ready');
      const preReadyError = await waitForEvent(it, e => e.type === 'error');
      expect(preReadyError).toEqual(expect.objectContaining({ type: 'error', code: 'event_mapping_failed' }));

      // Mapping failure AFTER ready should be emitted immediately.
      q.push({ type: 'message', data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
      const postReadyError = await waitForEvent(it, e => e.type === 'error');
      expect(postReadyError).toEqual(expect.objectContaining({ type: 'error', code: 'event_mapping_failed' }));

      await session.close();
      expect(sent.some(m => m.type === 'session.update')).toBe(true);
    });
  });
});
