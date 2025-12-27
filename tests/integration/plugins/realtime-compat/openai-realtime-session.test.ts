import { createRequire } from 'module';

import { createOpenAIRealtimeCompatSession } from '@/plugins/realtime-compat/openai/internal/session.ts';

const require = createRequire(import.meta.url);
const wsLib = require('ws');

async function startWsServer() {
  const wss = new wsLib.WebSocketServer({ port: 0 });
  const messages: any[] = [];

  let socket: any | undefined;
  let lastRequestUrl: string | undefined;
  wss.on('connection', (ws: any, req: any) => {
    socket = ws;
    lastRequestUrl = String(req?.url ?? '');
    ws.on('message', (data: any) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {
        messages.push({ type: '__unparsed__', raw: data.toString() });
      }
    });
  });

  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');

  const urlTemplate = `ws://127.0.0.1:${address.port}/realtime?model={model}`;

  const close = async () => {
    try {
      socket?.close?.();
    } catch {}
    await new Promise<void>(resolve => wss.close(() => resolve()));
  };

  const closeSocketOnly = () => {
    try {
      socket?.close?.();
    } catch {}
  };

  const sendToClient = (evt: any) => {
    if (!socket) throw new Error('No socket connected');
    socket.send(typeof evt === 'string' ? evt : JSON.stringify(evt));
  };

  return { urlTemplate, messages, sendToClient, close, closeSocketOnly, getLastRequestUrl: () => lastRequestUrl };
}

async function waitForMessage(messages: any[], predicate: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise(res => setTimeout(res, 10));
  }
  throw new Error('Timed out waiting for message');
}

async function waitForReady(session: any, server: { messages: any[]; sendToClient: (evt: any) => void }) {
  const it = session.events()[Symbol.asyncIterator]();
  await waitForMessage(server.messages, m => m?.type === 'session.update', 2000);
  server.sendToClient({ type: 'session.updated', session: { type: 'realtime' } });
  const first = await it.next();
  expect(first.done).toBe(false);
  expect(first.value.type).toBe('ready');
  return it;
}

describe('integration/realtime-compat/openai session', () => {
  test('connects, emits ready first, and sends session.update', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'openai', model: 'm', transcription: { enabled: true }, turnDetection: { mode: 'manual_commit' } }
      } as any);

      const it = session.events()[Symbol.asyncIterator]();
      await waitForMessage(server.messages, m => m?.type === 'session.update', 2000);

      // Cover buffering before ready: send a mappable event before session.updated.
      server.sendToClient({ type: 'response.output_text.delta', delta: 'x' });
      server.sendToClient({ type: 'session.updated', session: { type: 'realtime' } });

      const first = await it.next();
      expect(first.done).toBe(false);
      expect(first.value.type).toBe('ready');

      const mapped = await it.next();
      expect(mapped.value).toEqual({ type: 'assistant_text.delta', textDelta: 'x' });

      await session.close();
      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });

  test('injectContext sends conversation item create events for system/user/assistant history', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        },
        spec: {
          provider: 'openai',
          model: 'stub-model',
          transcription: { enabled: true },
          timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
        },
        tools: []
      } as any);

      const it = await waitForReady(session as any, server);

      await session.injectContext([
        { role: 'system', text: 'sys' },
        { role: 'user', text: 'u' },
        { role: 'assistant', text: 'a' }
      ]);

      await waitForMessage(server.messages, m => m?.type === 'conversation.item.create' && m?.item?.role === 'assistant', 2000);

      const messageItems = server.messages.filter(m => m?.type === 'conversation.item.create' && m?.item?.type === 'message');
      expect(messageItems.map((m: any) => m.item.role)).toEqual(['system', 'user', 'assistant']);
      expect(messageItems[0].item.content[0]).toEqual({ type: 'input_text', text: 'sys' });
      expect(messageItems[1].item.content[0]).toEqual({ type: 'input_text', text: 'u' });
      expect(messageItems[2].item.content[0]).toEqual({ type: 'text', text: 'a' });

      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });

  test('sends text, audio, commit, interrupt, and tool results with correct event shapes', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: {
          provider: 'openai',
          model: 'm',
          turnDetection: { mode: 'manual_commit' },
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          }
        }
      } as any);

      // Wait for ready so the websocket is open/configured
      await waitForReady(session, server);

      await session.sendText({ role: 'user', text: 'hi' });
      await waitForMessage(server.messages, m => m?.type === 'conversation.item.create' && m?.item?.role === 'user', 2000);

      await session.sendAudio({ format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AAA=' });
      await waitForMessage(server.messages, m => m?.type === 'input_audio_buffer.append', 2000);

      await session.commit();
      await waitForMessage(server.messages, m => m?.type === 'input_audio_buffer.commit', 2000);
      await waitForMessage(server.messages, m => m?.type === 'response.create', 2000);

      await session.interrupt();
      await waitForMessage(server.messages, m => m?.type === 'response.cancel', 2000);

      await session.sendToolResult({ toolCallId: 'c1', result: { ok: true } });
      await waitForMessage(
        server.messages,
        m => m?.type === 'conversation.item.create' && m?.item?.type === 'function_call_output' && m?.item?.call_id === 'c1',
        2000
      );
      await waitForMessage(server.messages, m => m?.type === 'response.create', 2000);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('commit without audio sends response.create only', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'openai', model: 'm', turnDetection: { mode: 'manual_commit' } }
      } as any);

      await waitForReady(session, server);

      await session.sendText({ text: 'hi' });
      await session.commit();
      await waitForMessage(server.messages, m => m?.type === 'response.create', 2000);
      expect(server.messages.some(m => m?.type === 'input_audio_buffer.commit')).toBe(false);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('commit forces tool_choice required for toolChoice.single (per-response override)', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: {
          provider: 'openai',
          model: 'm',
          toolChoice: { type: 'single', name: 'test.echo' },
          turnDetection: { mode: 'manual_commit' }
        },
        tools: [{ name: 'test.echo' }]
      } as any);

      await waitForReady(session, server);

      await session.sendText({ text: 'hi' });
      await session.commit();

      await waitForMessage(server.messages, m => m?.type === 'response.create' && m?.response?.tool_choice === 'required', 2000);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('commit after audio does not send input_audio_buffer.commit or response.create in server_vad mode', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: {
          provider: 'openai',
          model: 'm',
          turnDetection: { mode: 'server_vad' },
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          }
        }
      } as any);

      await waitForReady(session, server);

      await session.sendAudio({ format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AAA=' });
      await session.commit();
      await new Promise(res => setTimeout(res, 25));
      expect(server.messages.some(m => m?.type === 'response.create')).toBe(false);
      expect(server.messages.some(m => m?.type === 'input_audio_buffer.commit')).toBe(false);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('commit after text sends response.create (but not input_audio_buffer.commit) in server_vad mode', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'openai', model: 'm', turnDetection: { mode: 'server_vad' } }
      } as any);

      await waitForReady(session, server);

      await session.sendText({ text: 'hi' });
      await session.commit();

      await waitForMessage(server.messages, m => m?.type === 'response.create', 2000);
      expect(server.messages.some(m => m?.type === 'input_audio_buffer.commit')).toBe(false);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('resets audio bookkeeping on input_audio_buffer.committed (avoids extra commit)', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'openai', model: 'm', turnDetection: { mode: 'manual_commit' } }
      } as any);

      const it = await waitForReady(session, server);

      await session.sendAudio({ format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AAA=' });
      // Simulate server-side commit (e.g., VAD path) so local bookkeeping resets.
      server.sendToClient({ type: 'input_audio_buffer.committed' });
      // Force a deterministic wait for the server message to be processed by
      // waiting for a subsequent mapped event (messages are processed in-order).
      server.sendToClient({ type: 'response.output_text.delta', delta: 'x' });
      while (true) {
        const evt = await it.next();
        if (evt.done) throw new Error('Expected assistant_text.delta');
        if (evt.value.type === 'assistant_text.delta') break;
      }

      await session.commit();
      await waitForMessage(server.messages, m => m?.type === 'response.create', 2000);
      expect(server.messages.some(m => m?.type === 'input_audio_buffer.commit')).toBe(false);

      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });

  test('server error before session.updated yields ready then error', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'openai', model: 'm' }
      } as any);

      const it = session.events()[Symbol.asyncIterator]();
      await waitForMessage(server.messages, m => m?.type === 'session.update', 2000);

      server.sendToClient({ type: 'error', error: { message: 'nope', code: 'x' } });

      const first = await it.next();
      expect(first.value.type).toBe('ready');

      const second = await it.next();
      expect(second.value).toEqual({ type: 'error', message: 'nope', code: 'x' });

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('buffers mapping failures before ready and flushes after session.updated', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'openai', model: 'm' }
      } as any);

      const it = session.events()[Symbol.asyncIterator]();
      await waitForMessage(server.messages, m => m?.type === 'session.update', 2000);

      // Trigger a mapper exception before ready.
      server.sendToClient({ type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '[]' });
      server.sendToClient({ type: 'session.updated', session: { type: 'realtime' } });

      const first = await it.next();
      expect(first.value.type).toBe('ready');

      const second = await it.next();
      expect(second.value.type).toBe('error');
      expect((second.value as any).code).toBe('event_mapping_failed');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('commit waits briefly for response.done cancelled after interrupt', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'openai', model: 'm', turnDetection: { mode: 'manual_commit' } }
      } as any);

      await waitForReady(session, server);

      await session.interrupt();
      await session.interrupt();
      await waitForMessage(server.messages, m => m?.type === 'response.cancel', 2000);

      const commitTask = session.commit();
      await new Promise(res => setTimeout(res, 25));
      expect(server.messages.some(m => m?.type === 'response.create')).toBe(false);

      // Cover both "missing status" and alternate spelling ("canceled") branches.
      server.sendToClient({ type: 'response.done', response: {} });
      server.sendToClient({ type: 'response.done', response: { status: 'canceled' } });
      await commitTask;
      await waitForMessage(server.messages, m => m?.type === 'response.create', 2000);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('emits error on invalid JSON and mapping failures (without breaking the event stream)', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'openai', model: 'm' }
      } as any);

      const it = await waitForReady(session, server);

      server.sendToClient('not-json');
      const invalid = await it.next();
      expect(invalid.value).toEqual({ type: 'error', message: 'Failed to parse realtime event JSON', code: 'invalid_json' });

      server.sendToClient({ type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '[]' });
      const mappingErr = await it.next();
      expect(mappingErr.value.type).toBe('error');
      expect((mappingErr.value as any).code).toBe('event_mapping_failed');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('includes model via query config when urlTemplate omits {model}', async () => {
    const server = await startWsServer();
    try {
      const urlTemplateNoModel = server.urlTemplate.replace('?model={model}', '');
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: {
            urlTemplate: urlTemplateNoModel,
            headers: {},
            query: { model: '{model}', extra: '1' }
          }
        } as any,
        spec: { provider: 'openai', model: 'm' }
      } as any);

      await waitForReady(session, server);

      // Ensure the ws server saw the query params from config.
      const reqUrl = server.getLastRequestUrl();
      expect(String(reqUrl)).toContain('model=m');
      expect(String(reqUrl)).toContain('extra=1');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('uses provider realtime metadata defaultModel when spec.model is missing', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} },
          metadata: { defaultModel: 'm' }
        } as any,
        spec: { provider: 'openai' }
      } as any);

      await waitForReady(session, server);

      const reqUrl = server.getLastRequestUrl();
      expect(String(reqUrl)).toContain('model=m');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('emits provider_close when server closes the socket (covers close handler path)', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'openai', model: 'm' }
      } as any);

      const it = await waitForReady(session, server);

      server.closeSocketOnly();
      const closed = await it.next();
      expect(closed.value).toEqual({ type: 'closed', reason: 'provider_close' });
    } finally {
      await server.close();
    }
  });

  test('covers ws error handler and ws-not-open guard', async () => {
    const session = createOpenAIRealtimeCompatSession({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://127.0.0.1:1/realtime?model={model}', headers: {} }
      } as any,
      spec: { provider: 'openai', model: 'm' }
    } as any);

    // Not open yet → guard fires.
    await expect(session.sendText({ role: 'user', text: 'hi' })).rejects.toThrow('not open');

    const it = session.events()[Symbol.asyncIterator]();
    const ready = await it.next();
    expect(ready.value.type).toBe('ready');

    // Connection refused should surface as ws_error.
    const err = await it.next();
    expect(err.value.type).toBe('error');
    expect((err.value as any).code).toBe('ws_error');

    // Close before open branch (terminate) should not throw.
    await session.close();
  });

  test('close before open uses terminate branch', async () => {
    const session = createOpenAIRealtimeCompatSession({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://127.0.0.1:1/realtime?model={model}', headers: {} }
      } as any,
      spec: { provider: 'openai', model: 'm' }
    } as any);

    // Immediately close; websocket is almost certainly not open yet.
    await session.close();
  });

  test('methods reject after close (covers closed guard)', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'openai', model: 'm' }
      } as any);

      const it = await waitForReady(session, server);

      await session.close();
      await expect(session.commit()).rejects.toThrow('closed');
    } finally {
      await server.close();
    }
  });

  test('throws on missing realtime config or missing model', async () => {
    expect(() =>
      createOpenAIRealtimeCompatSession({
        provider: { id: 'openai', compat: 'openai', endpoint: { urlTemplate: '', headers: {} } } as any,
        spec: { provider: 'openai', model: 'm' }
      } as any)
    ).toThrow('missing realtime endpoint');

    const server = await startWsServer();
    try {
      expect(() =>
        createOpenAIRealtimeCompatSession({
          provider: {
            id: 'openai',
            compat: 'openai',
            endpoint: { urlTemplate: server.urlTemplate, headers: {} }
          } as any,
          spec: { provider: 'openai' }
        } as any)
      ).toThrow("requires 'model'");
    } finally {
      await server.close();
    }
  });
});
