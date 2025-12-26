import { jest } from '@jest/globals';
import { LruMap } from '@/kernel/index.ts';

describe('kernel/lru-map', () => {
  test('evicts the oldest entry when over maxEntries', () => {
    const map = new LruMap<string, number>(2);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);

    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
    expect(map.has('c')).toBe(true);
  });

  test('treats get() as a recency refresh (LRU)', () => {
    const map = new LruMap<string, number>(2);
    map.set('a', 1);
    map.set('b', 2);

    // Touch 'a' so 'b' becomes oldest.
    expect(map.get('a')).toBe(1);
    expect(map.get('missing')).toBeUndefined();

    map.set('c', 3);

    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(true);
  });

  test('set() updates existing keys without growing size', () => {
    const map = new LruMap<string, number>(10);
    map.set('a', 1);
    map.set('a', 2);
    expect(map.size).toBe(1);
    expect(map.get('a')).toBe(2);
  });

  test('invokes onEvict with key/value for each evicted entry', () => {
    const evicted: Array<{ key: string; value: number }> = [];
    const map = new LruMap<string, number>(1, {
      onEvict: (entry) => evicted.push(entry)
    });

    map.set('a', 1);
    map.set('b', 2);

    expect(evicted).toEqual([{ key: 'a', value: 1 }]);
  });

  test('optionally logs a warning on eviction', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const withLabel = new LruMap<string, number>(1, { warnOnEvict: true, label: 'test' });
    withLabel.set('a', 1);
    withLabel.set('b', 2);

    const withoutLabel = new LruMap<string, number>(1, { warnOnEvict: true });
    withoutLabel.set('a', 1);
    withoutLabel.set('b', 2);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      'LRU map eviction',
      expect.objectContaining({ label: 'test', key: 'a', maxEntries: 1 })
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      'LRU map eviction',
      expect.objectContaining({ key: 'a', maxEntries: 1 })
    );
    expect((warn.mock.calls[1]?.[1] as any)?.label).toBeUndefined();

    warn.mockRestore();
  });

  test('setMaxEntries() can trigger eviction', () => {
    const map = new LruMap<string, number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);

    map.setMaxEntries(2);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
    expect(map.has('c')).toBe(true);
    expect(map.getMaxEntries()).toBe(2);
  });

  test('normalizes invalid maxEntries to >= 1', () => {
    const map = new LruMap<string, number>(0);
    expect(map.getMaxEntries()).toBe(1);
  });
});
