export class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const next = this.resolvers.shift();
    if (next) {
      next({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const next = this.resolvers.shift();
      if (next) next({ value: undefined as any, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift()!, done: false };
    }
    if (this.closed) {
      return { value: undefined as any, done: true };
    }
    return await new Promise(resolve => this.resolvers.push(resolve));
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      const { value, done } = await this.next();
      if (done) return;
      yield value;
    }
  }
}

