export interface LruMapOptions<K, V> {
  /**
   * Optional label included in eviction warnings.
   */
  label?: string;

  /**
   * When enabled, logs a warn-level message via `console.warn` on eviction.
   */
  warnOnEvict?: boolean;

  onEvict?: (options: { key: K; value: V }) => void;
}

function normalizeMaxEntries(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

/**
 * A tiny LRU map implemented by re-inserting on `get()` and evicting the oldest
 * entry when `maxEntries` is exceeded.
 *
 * Notes:
 * - Uses Map insertion order: "oldest" is the first key in iteration order.
 * - `get()` refreshes recency (moves the key to the end).
 */
export class LruMap<K, V> extends Map<K, V> {
  private maxEntries: number;
  private readonly label?: string;
  private readonly warnOnEvict: boolean;
  private readonly onEvict?: LruMapOptions<K, V>['onEvict'];

  constructor(maxEntries: number, options: LruMapOptions<K, V> = {}) {
    super();
    this.maxEntries = normalizeMaxEntries(maxEntries);
    this.label = options.label;
    this.warnOnEvict = options.warnOnEvict ?? false;
    this.onEvict = options.onEvict;
  }

  getMaxEntries(): number {
    return this.maxEntries;
  }

  setMaxEntries(next: number): void {
    this.maxEntries = normalizeMaxEntries(next);
    this.evictIfNeeded();
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key) as V;
    // Refresh recency.
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    // Refresh recency on update.
    if (super.has(key)) {
      super.delete(key);
    }
    super.set(key, value);
    this.evictIfNeeded();
    return this;
  }

  private evictIfNeeded(): void {
    while (this.size > this.maxEntries) {
      const oldestKey = this.keys().next().value as K;
      const oldestValue = super.get(oldestKey) as V;
      super.delete(oldestKey);
      this.onEvict?.({ key: oldestKey, value: oldestValue });
      if (this.warnOnEvict && typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('LRU map eviction', {
          ...(this.label ? { label: this.label } : {}),
          key: oldestKey,
          maxEntries: this.maxEntries
        });
      }
    }
  }
}
