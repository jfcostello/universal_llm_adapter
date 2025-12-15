import { writeSseEvent } from '@/modules/server/internal/streaming/sse.ts';
import { writeSseEventWithBackpressure } from '@/modules/server/internal/streaming/sse.ts';

describe('utils/server writeSseEvent', () => {
  test('writes SSE framed JSON event', () => {
    const chunks: string[] = [];
    const res: any = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      }
    };

    writeSseEvent(res, { type: 'delta', content: 'Hi' });

    expect(chunks.join('')).toBe(`data: ${JSON.stringify({ type: 'delta', content: 'Hi' })}\n\n`);
  });

  test('accepts pre-serialized string payload', () => {
    const chunks: string[] = [];
    const res: any = { write: (chunk: string) => (chunks.push(chunk), true) };
    writeSseEvent(res, '{"type":"done"}');
    expect(chunks.join('')).toBe('data: {"type":"done"}\n\n');
  });

  test('awaits drain when write backpressures', async () => {
    let drainCb: any;
    const res: any = {
      write: () => false,
      once: (_evt: string, cb: any) => {
        drainCb = cb;
      }
    };

    const p = writeSseEventWithBackpressure(res, { type: 'delta', content: 'Hi' });
    expect(typeof drainCb).toBe('function');
    drainCb();
    await expect(p).resolves.toBeUndefined();
  });

  test('resolves immediately when no backpressure', async () => {
    const res: any = { write: () => true };
    await expect(writeSseEventWithBackpressure(res, { type: 'done' })).resolves.toBeUndefined();
  });

  test('handles string payload in backpressure writer', async () => {
    const chunks: string[] = [];
    const res: any = { write: (c: string) => (chunks.push(c), true) };
    await writeSseEventWithBackpressure(res, '{"type":"done"}');
    expect(chunks.join('')).toContain('data: {"type":"done"}');
  });
});
