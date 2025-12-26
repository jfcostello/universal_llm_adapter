import { jest } from '@jest/globals';
import type { RealtimeAudioFrame, RealtimeEvent } from '@/kernel/index.ts';
import { AsyncQueue } from '@/kernel/index.ts';
import type { RealtimeSession } from '@/modules/realtime/index.ts';

export class MockRealtimeSession implements RealtimeSession {
  sendText = jest.fn(async (_options: { text: string; role?: 'system' | 'user' }) => {});
  injectContext = jest.fn(async (_items: any[]) => {});
  sendDTMF = jest.fn(async (_digit: string) => {});
  sendAudio = jest.fn(async (_frame: RealtimeAudioFrame) => {});
  commit = jest.fn(async () => {});
  interrupt = jest.fn(async (_options?: { reason?: string }) => {});
  close = jest.fn(async () => {
    this.queue.push({ type: 'closed', reason: 'client_close' });
    this.queue.close();
  });

  private readonly queue = new AsyncQueue<RealtimeEvent>();

  events(): AsyncIterable<RealtimeEvent> {
    return this.queue.iterate();
  }

  push(event: RealtimeEvent) {
    this.queue.push(event);
  }

  finish() {
    this.queue.close();
  }
}
