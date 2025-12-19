import { EventEmitter } from 'events';

export class MockWebSocket extends EventEmitter {
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  readyState: number = 1;

  send(data: string) {
    this.sent.push(String(data));
  }

  close(code?: number, reason?: string) {
    this.closed.push({ code, reason });
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.emit('close');
    }
  }

  emitMessage(data: any) {
    this.emit('message', data);
  }
}

