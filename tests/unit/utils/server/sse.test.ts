import { writeSseEvent } from '@/utils/server/internal/sse.ts';

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
});
