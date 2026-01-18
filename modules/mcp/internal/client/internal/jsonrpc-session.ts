import { EventEmitter } from 'events';
import type { Readable, Writable } from 'stream';

import { getDefaults } from '../../../../../kernel/index.js';

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class JSONRPCSession extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private buffer = '';

  constructor(
    private input: Readable,
    private output: Writable
  ) {
    super();
    this.setupStreams();
  }

  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.timer) clearTimeout(entry.timer);
      try {
        entry.reject(error);
      } catch {
        // best-effort
      }
      this.pending.delete(id);
    }
  }

  private setupStreams(): void {
    this.input.on('data', chunk => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    const onClosed = () => {
      this.failAllPending(new Error('MCP connection closed'));
    };

    const onError = (err: any) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.failAllPending(error);
    };

    this.input.on('end', onClosed);
    this.input.on('close', onClosed);
    this.input.on('error', onError);

    (this.output as any).on?.('error', onError);
    (this.output as any).on?.('close', onClosed);
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);
        if (message.id && this.pending.has(message.id)) {
          const entry = this.pending.get(message.id)!;
          this.pending.delete(message.id);

          if (entry.timer) clearTimeout(entry.timer);

          if (message.error) entry.reject(new Error(message.error.message));
          else entry.resolve(message.result);
        } else if (message.method) {
          this.emit('notification', message);
        }
      } catch {
        // skip invalid JSON
      }
    }
  }

  async request(method: string, params?: any, timeoutMs?: number): Promise<any> {
    const effectiveTimeout = timeoutMs ?? getDefaults().timeouts.mcpRequest;
    const id = this.nextId++;

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject };
      this.pending.set(id, entry);

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, effectiveTimeout);
      entry.timer = timeout;

      this.output.write(JSON.stringify(request) + '\n', error => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
}

