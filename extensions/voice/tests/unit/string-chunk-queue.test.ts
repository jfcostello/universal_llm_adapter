import { StringChunkQueue } from '../../modules/shared/index.js';

describe('extensions/voice/internal/StringChunkQueue', () => {
  test('tracks byte length and shift ordering', () => {
    const q = new StringChunkQueue();
    q.push('a');
    q.push('bb');
    expect(q.byteLength()).toBe(3);

    const first = q.shift();
    expect(first).toEqual({ chunk: 'a', bytes: 1 });
    expect(q.byteLength()).toBe(2);

    const second = q.shift();
    expect(second).toEqual({ chunk: 'bb', bytes: 2 });
    expect(q.byteLength()).toBe(0);

    expect(q.shift()).toBeUndefined();
  });

  test('does not compact when nothing consumed', () => {
    const q = new StringChunkQueue();
    (q as any).compactIfNeeded();
    const internal = q as any;
    expect(internal.chunks.length).toBe(0);
    expect(internal.start).toBe(0);
  });

  test('does not compact when consumed is small relative to backing length', () => {
    const q = new StringChunkQueue();

    for (let i = 0; i < 5000; i += 1) q.push('x');
    for (let i = 0; i < 1024; i += 1) q.shift();

    const internal = q as any;
    expect(internal.start).toBe(1024);
    expect(internal.chunks.length).toBe(5000);
  });

  test('compacts consumed prefix when the queue never fully drains', () => {
    const q = new StringChunkQueue();
    q.push('seed');

    for (let i = 0; i < 5000; i += 1) {
      q.push('x');
      q.shift();
    }

    // Private fields are inspected here to ensure internal storage stays bounded under steady-state usage.
    const internal = q as any;
    expect(internal.chunks.length).toBeLessThan(2048);
    expect(internal.start).toBeLessThan(2048);

    const last = q.shift();
    expect(last?.chunk).toBe('x');
    expect(q.byteLength()).toBe(0);
  });
});
