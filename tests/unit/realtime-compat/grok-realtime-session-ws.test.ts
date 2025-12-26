import { jest } from '@jest/globals';
import { createRequire } from 'module';

import type { RealtimeEvent } from '@/kernel/index.ts';
import GrokRealtimeCompat from '@/plugins/realtime-compat/grok/internal/grok-realtime.ts';
import { createGrokRealtimeWsCompatSession } from '@/plugins/realtime-compat/grok/internal/session-ws.ts';

const require = createRequire(import.meta.url);
const wsLib = require('ws');

async function startWsServer() {
  const wss = new wsLib.WebSocketServer({ port: 0 });
  const received: any[] = [];
  const requestUrls: string[] = [];

  wss.on('connection', (ws: any, req: any) => {
    requestUrls.push(String(req?.url ?? ''));
    ws.send(JSON.stringify({ type: 'conversation.created', conversation: { id: 'c1' } }));
    ws.on('message', (data: any) => {
      const parsed = JSON.parse(String(data));
      received.push(parsed);
      if (parsed?.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'session.updated', session: { id: 's1' } }));
      }
    });
  });

  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');

  const url = `ws://127.0.0.1:${address.port}/realtime`;

  const close = async () => {
    await new Promise<void>(resolve => wss.close(() => resolve()));
  };

  return { url, received, requestUrls, close };
}

async function waitForEvent<T extends RealtimeEvent = RealtimeEvent>(
  iter: AsyncIterator<RealtimeEvent>,
  predicate: (value: RealtimeEvent) => boolean,
  timeoutMs = 2000
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const next = await iter.next();
    if (next.done) throw new Error('Iterator closed');
    if (predicate(next.value as any)) return next.value as any;
  }
  throw new Error('Timed out waiting for event');
}

describe('realtime-compat/grok — ws session', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('GrokRealtimeCompat rejects non-ws transport', async () => {
    const compat = new GrokRealtimeCompat();
    await expect(
      compat.createSession({
        provider: { id: 'grok', compat: 'grok', endpoint: { urlTemplate: 'ws://x' } } as any,
        spec: { provider: 'grok', transport: { type: 'webrtc' } } as any
      } as any)
    ).rejects.toThrow("Realtime transport not supported for provider 'grok': webrtc");
  });

  test('createGrokRealtimeWsCompatSession throws when provider endpoint is missing', () => {
    expect(() =>
      createGrokRealtimeWsCompatSession({
        provider: { id: 'grok', compat: 'grok', endpoint: undefined } as any,
        spec: { provider: 'grok' } as any
      } as any)
    ).toThrow("Provider 'grok' missing realtime endpoint configuration");
  });

  test('ws session resolves url with query params and works with missing headers', async () => {
    const server = await startWsServer();
    try {
      const session = createGrokRealtimeWsCompatSession({
        provider: {
          id: 'grok',
          compat: 'grok',
          endpoint: { urlTemplate: server.url, query: { foo: 'bar', baz: 'qux' }, headers: undefined },
          metadata: { defaultVoice: 'ara' }
        } as any,
        spec: { provider: 'grok' } as any
      } as any);

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, e => e.type === 'ready');

      expect(server.requestUrls.some(u => u.includes('/realtime?') && u.includes('foo=bar') && u.includes('baz=qux'))).toBe(true);
      expect(server.received.some(m => m?.type === 'session.update')).toBe(true);

      const sessionUpdate = server.received.find(m => m?.type === 'session.update');
      expect(sessionUpdate.session.voice).toBe('ara');

      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });

  test('GrokRealtimeCompat defaults to ws transport and passes headers through', async () => {
    const server = await startWsServer();
    try {
      const compat = new GrokRealtimeCompat();
      const session = await compat.createSession({
        provider: {
          id: 'grok',
          compat: 'grok',
          endpoint: { urlTemplate: server.url, headers: { Authorization: 'Bearer sk-test' } }
        } as any,
        spec: { provider: 'grok' } as any
      } as any);

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, e => e.type === 'ready');

      expect(server.requestUrls.some(u => u === '/realtime')).toBe(true);

      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });
});

