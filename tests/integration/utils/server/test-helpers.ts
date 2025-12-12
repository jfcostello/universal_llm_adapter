import { jest } from '@jest/globals';
import http from 'http';
import { createServer } from '@/utils/server/index.ts';
import type { LLMCallSpec } from '@/core/types.ts';

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface MockServerDepsResult {
  deps: any;
  coordinators: any[];
}

export const baseSpec: LLMCallSpec = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  llmPriority: [{ provider: 'placeholder', model: 'placeholder' }],
  settings: { temperature: 0 }
} as any;

export function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function canBindToLocalhost(): Promise<boolean> {
  const probe = http.createServer((_, res) => res.end('ok'));
  try {
    await new Promise<void>((resolve, reject) => {
      probe.listen(0, '127.0.0.1', resolve);
      probe.on('error', reject);
    });
    return true;
  } catch (error: any) {
    if (error?.code === 'EPERM') return false;
    throw error;
  } finally {
    probe.close();
  }
}

export function createMockServerDeps(
  createCoordinatorImpl: () => any
): MockServerDepsResult {
  const coordinators: any[] = [];

  return {
    deps: {
      createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
      createCoordinator: jest.fn().mockImplementation(() => {
        const coordinator = createCoordinatorImpl();
        coordinators.push(coordinator);
        return coordinator;
      }),
      closeLogger: jest.fn().mockResolvedValue(undefined)
    },
    coordinators
  };
}

export async function startServer(
  options: any,
  createCoordinatorImpl: () => any
): Promise<{ server: Awaited<ReturnType<typeof createServer>>; coordinators: any[] }> {
  const { deps, coordinators } = createMockServerDeps(createCoordinatorImpl);
  const server = await createServer({ ...(options ?? {}), deps });
  return { server, coordinators };
}

export function requestRaw(
  url: string,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(options.path, url);
    const req = http.request(
      {
        method: options.method,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: options.headers
      },
      (res) => {
        let body = '';
        res.on('data', chunk => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export function postJson(
  url: string,
  path: string,
  payload: any,
  headers: Record<string, string> = { 'Content-Type': 'application/json' }
): Promise<HttpResult> {
  return requestRaw(url, {
    method: 'POST',
    path,
    headers,
    body: JSON.stringify(payload)
  });
}

interface SseClient {
  ready: Promise<void>;
  ended: Promise<void>;
  getStatus: () => number | undefined;
  getHeaders: () => http.IncomingHttpHeaders | undefined;
  events: any[];
  raw: string;
  waitForEventCount: (n: number, timeoutMs?: number) => Promise<void>;
  destroy: () => void;
}

export function openSse(
  url: string,
  path: string,
  payload: any,
  headers: Record<string, string> = { 'Content-Type': 'application/json' }
): SseClient {
  const target = new URL(path, url);
  let status: number | undefined;
  let responseHeaders: http.IncomingHttpHeaders | undefined;
  const events: any[] = [];
  let buffer = '';
  let raw = '';

  let resolveReady: () => void;
  const ready = new Promise<void>(resolve => {
    resolveReady = resolve;
  });

  let resolveEnded: () => void;
  const ended = new Promise<void>(resolve => {
    resolveEnded = resolve;
  });

  const waiters: Array<{
    n: number;
    resolve: () => void;
    reject: (err: any) => void;
    timeoutId: NodeJS.Timeout;
  }> = [];

  function notifyWaiters() {
    for (const waiter of [...waiters]) {
      if (events.length >= waiter.n) {
        clearTimeout(waiter.timeoutId);
        waiter.resolve();
        waiters.splice(waiters.indexOf(waiter), 1);
      }
    }
  }

  const req = http.request(
    {
      method: 'POST',
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers
    },
    (res) => {
      status = res.statusCode ?? 0;
      responseHeaders = res.headers;
      resolveReady();

      res.on('data', chunk => {
        const str = chunk.toString();
        raw += str;
        buffer += str;

        while (true) {
          const idx = buffer.indexOf('\n\n');
          if (idx < 0) break;
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const line = frame.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          const data = line.slice('data:'.length).trim();
          if (!data) continue;
          try {
            events.push(JSON.parse(data));
          } catch {
            events.push(data);
          }
          notifyWaiters();
        }
      });

      res.on('end', () => {
        resolveEnded();
      });
    }
  );

  req.write(JSON.stringify(payload));
  req.end();

  return {
    ready,
    ended,
    getStatus: () => status,
    getHeaders: () => responseHeaders,
    events,
    get raw() {
      return raw;
    },
    waitForEventCount: (n: number, timeoutMs = 1000) =>
      new Promise<void>((resolve, reject) => {
        if (events.length >= n) {
          resolve();
          return;
        }
        const timeoutId = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${n} SSE event(s)`));
        }, timeoutMs);
        waiters.push({ n, resolve, reject, timeoutId });
      }),
    destroy: () => {
      req.destroy();
    }
  };
}
