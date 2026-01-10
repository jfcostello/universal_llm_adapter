export class ResettableQueue<T extends {}> {
  private queue: T[] = [];
  private head = 0;
  private waiting: Array<(value: T | null | undefined) => void> = [];
  private closed = false;
  private generation = 0;

  push(item: T) {
    if (this.closed) return;
    const next = this.waiting.shift();
    if (next) next(item);
    else this.queue.push(item);
  }

  size(): number {
    return this.queue.length - this.head;
  }

  currentGeneration(): number {
    return this.generation;
  }

  private maybeCompact(): void {
    // Avoid unbounded growth and keep dequeue O(1) without shift().
    if (this.head <= 1024) return;
    if (this.head <= this.queue.length / 2) return;

    this.queue = this.queue.slice(this.head);
    this.head = 0;
  }

  async next(): Promise<{ value: T | null; generation: number } | null> {
    if (this.head < this.queue.length) {
      const value = this.queue[this.head++]!;
      this.maybeCompact();
      return { value, generation: this.generation };
    }
    if (this.closed) return null;
    return await new Promise(resolve => {
      this.waiting.push((value) => {
        if (value === undefined) resolve(null);
        else resolve({ value, generation: this.generation });
      });
    });
  }

  async nextValue(): Promise<T | null> {
    while (true) {
      const next = await this.next();
      if (next === null) return null;
      if (next.value === null) continue;
      return next.value;
    }
  }

  clear() {
    this.queue = [];
    this.head = 0;
    this.generation++;
    for (const fn of this.waiting.splice(0, this.waiting.length)) fn(null);
  }

  close() {
    this.closed = true;
    for (const fn of this.waiting.splice(0, this.waiting.length)) fn(undefined);
    this.queue = [];
    this.head = 0;
  }
}
