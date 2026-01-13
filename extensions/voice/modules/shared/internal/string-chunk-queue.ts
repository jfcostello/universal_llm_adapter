export class StringChunkQueue {
  private readonly chunks: string[] = [];
  private readonly byteLengths: number[] = [];
  private start = 0;
  private totalBytes = 0;

  byteLength(): number {
    return this.totalBytes;
  }

  push(chunk: string): void {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    this.chunks.push(chunk);
    this.byteLengths.push(bytes);
    this.totalBytes += bytes;
  }

  shift(): { chunk: string; bytes: number } | undefined {
    if (this.start >= this.chunks.length) return undefined;

    const idx = this.start;
    const chunk = this.chunks[idx] as string;
    const bytes = this.byteLengths[idx] as number;

    // Release references for consumed slots (the queue may never fully drain under backpressure).
    this.chunks[idx] = '';
    this.byteLengths[idx] = 0;

    this.start = idx + 1;
    this.totalBytes -= bytes;

    if (this.start >= this.chunks.length) {
      this.clear();
      return { chunk, bytes };
    }

    this.compactIfNeeded();
    return { chunk, bytes };
  }

  clear(): void {
    this.chunks.length = 0;
    this.byteLengths.length = 0;
    this.start = 0;
    this.totalBytes = 0;
  }

  private compactIfNeeded(): void {
    const consumed = this.start;
    if (consumed <= 0) return;

    // Avoid unbounded growth of the backing arrays when the queue never fully drains.
    if (consumed < 1024) return;
    if (consumed * 2 < this.chunks.length) return;

    this.chunks.splice(0, consumed);
    this.byteLengths.splice(0, consumed);
    this.start = 0;
  }
}
