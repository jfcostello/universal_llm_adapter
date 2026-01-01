import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';

import { createRealtimeSessionController } from '@/modules/realtime/internal/realtime-session.ts';

import type { RealtimeCompatSession } from '@/kernel/index.ts';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function collectAll<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function extractTextFromMessages(messages: any[]): string {
  return (messages ?? [])
    .map((m: any) => (m?.content ?? []).map((p: any) => p?.type === 'text' ? String(p.text ?? '') : '').join(''))
    .join('\n');
}

function extractTextFromContent(content: any[]): string {
  return (content ?? [])
    .filter((p: any) => p?.type === 'text')
    .map((p: any) => String(p.text ?? ''))
    .join('');
}

describe('modules/realtime: observability (per-turn traces)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('records request/response per commit with stable sessionId and includes systemPrompt in messages', async () => {
    const turn1 = createDeferred<void>();
    const turn2 = createDeferred<void>();

    let commitCount = 0;

    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(async () => {
        commitCount++;
        if (commitCount === 1) turn1.resolve();
        else turn2.resolve();
      }),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await turn1.promise;
        yield { type: 'assistant_text.final', text: 'ONE' };
        await turn2.promise;
        yield { type: 'assistant_text.final', text: 'TWO' };
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const exporter = {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      flush: jest.fn(async () => {})
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'rt_p' } as any,
      spec: {
        provider: 'rt_p',
        model: 'rt_m',
        systemPrompt: 'SYS_PROMPT',
        history: [{ role: 'user', text: 'HISTORY' }],
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      } as any,
      compatSession: compat as any,
      observability: {
        exporter,
        baseTraceId: 'trace',
        sessionId: 'session-abc',
        metadata: { correlationId: 'corr-1' },
        captureMessages: 'text',
        captureToolArgs: false,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      } as any
    } as any);

    const eventsTask = collectAll(session.events());

    await session.sendText({ text: 'U1', role: 'user' });
    await session.commit();
    await session.sendText({ text: 'U2', role: 'user' });
    await session.commit();

    await eventsTask;

    expect(exporter.recordLLMRequest).toHaveBeenCalledTimes(2);
    expect(exporter.recordLLMResponse).toHaveBeenCalledTimes(2);

    const req1 = exporter.recordLLMRequest.mock.calls[0]?.[0] as any;
    const res1 = exporter.recordLLMResponse.mock.calls[0]?.[0] as any;
    const req2 = exporter.recordLLMRequest.mock.calls[1]?.[0] as any;
    const res2 = exporter.recordLLMResponse.mock.calls[1]?.[0] as any;

    // Stable session grouping + per-turn traces
    expect(req1.sessionId).toBe('session-abc');
    expect(res1.sessionId).toBe('session-abc');
    expect(req2.sessionId).toBe('session-abc');
    expect(res2.sessionId).toBe('session-abc');

    expect(req1.traceId).toBe('trace');
    expect(req2.traceId).toBe('trace:2');

    expect(req1.generationId).toBeTruthy();
    expect(req1.generationId).toBe(res1.generationId);
    expect(req2.generationId).toBe(res2.generationId);

    // Request messages contain accumulated conversation (system + history + turns)
    const req1Text = extractTextFromMessages(req1.messages);
    expect(req1Text).toContain('SYS_PROMPT');
    expect(req1Text).toContain('HISTORY');
    expect(req1Text).toContain('U1');
    expect(req1Text).not.toContain('U2');

    const req2Text = extractTextFromMessages(req2.messages);
    expect(req2Text).toContain('SYS_PROMPT');
    expect(req2Text).toContain('HISTORY');
    expect(req2Text).toContain('U1');
    expect(req2Text).toContain('ONE');
    expect(req2Text).toContain('U2');

    expect(extractTextFromContent(res1.content)).toContain('ONE');
    expect(extractTextFromContent(res2.content)).toContain('TWO');
  });

  test('captureMessages=none redacts message/content bodies', async () => {
    const turn = createDeferred<void>();

    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(async () => turn.resolve()),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await turn.promise;
        yield { type: 'assistant_text.final', text: 'ONE' };
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const exporter = {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      flush: jest.fn(async () => {})
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'rt_p' } as any,
      spec: {
        provider: 'rt_p',
        model: 'rt_m',
        systemPrompt: 'SYS_PROMPT',
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      } as any,
      compatSession: compat as any,
      observability: {
        exporter,
        baseTraceId: 'trace',
        sessionId: 'session-abc',
        metadata: { correlationId: 'corr-1' },
        captureMessages: 'none',
        captureToolArgs: false,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      } as any
    } as any);

    const eventsTask = collectAll(session.events());
    await session.sendText({ text: 'U1', role: 'user' });
    await session.commit();
    await eventsTask;

    const req = exporter.recordLLMRequest.mock.calls[0]?.[0] as any;
    const res = exporter.recordLLMResponse.mock.calls[0]?.[0] as any;

    expect(Array.isArray(req.messages)).toBe(true);
    expect(req.messages).toEqual([]);
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content).toEqual([]);
  });

  test('logs observability events to live-test logs when LLM_LIVE=1', async () => {
    await withTempCwd('realtime-live-log', async (cwd) => {
      process.env.LLM_LIVE = '1';
      process.env.TEST_FILE = 'realtime-observability-unit';
      process.env.LLM_TEST_NAME = 'unit';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const turn = createDeferred<void>();
      const compat: RealtimeCompatSession = {
        sendText: jest.fn(),
        injectContext: jest.fn(),
        sendAudio: jest.fn(),
        commit: jest.fn(async () => turn.resolve()),
        interrupt: jest.fn(),
        sendToolResult: jest.fn(),
        close: jest.fn(),
        events: async function* () {
          yield { type: 'ready', sessionId: 's' };
          await turn.promise;
          yield { type: 'assistant_text.final', text: 'ONE' };
          yield { type: 'closed', reason: 'provider_close' };
        }
      };

      const exporter = {
        recordLLMRequest: jest.fn(),
        recordLLMResponse: jest.fn(),
        flush: jest.fn(async () => {})
      };

      const session = createRealtimeSessionController({
        registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
        provider: { id: 'rt_p' } as any,
        spec: {
          provider: 'rt_p',
          model: 'rt_m',
          systemPrompt: 'SYS_PROMPT',
          metadata: { correlationId: 'corr-1' },
          timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
        } as any,
        compatSession: compat as any,
        observability: {
          exporter,
          baseTraceId: 'trace',
          sessionId: 'session-abc',
          metadata: { correlationId: 'corr-1' },
          captureMessages: 'text',
          captureToolArgs: false,
          captureRequestPayload: false,
          captureRawResponse: false,
          sampleRate: 1,
          maxInputTextBytes: 4096,
          maxOutputTextBytes: 4096,
          maxJsonBytes: 8192
        } as any
      } as any);

      const eventsTask = collectAll(session.events());
      await session.sendText({ text: 'U1', role: 'user' });
      await session.commit();
      await eventsTask;

      const logFile = path.join(cwd, 'tests', 'live', 'logs', '2025-10-18-realtime-observability-unit.log');
      expect(fs.existsSync(logFile)).toBe(true);
      const content = fs.readFileSync(logFile, 'utf-8');
      expect(content).toContain('>>> OBSERVABILITY EVENT >>>');
      expect(content).toContain('TraceId: trace');
    });
  });

  test('commit does not record observability when baseTraceId is missing', async () => {
    const committed = createDeferred<void>();

    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(async () => committed.resolve()),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await committed.promise;
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const exporter = {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      flush: jest.fn(async () => {})
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'rt_p' } as any,
      spec: {
        provider: 'rt_p',
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      } as any,
      compatSession: compat as any,
      observability: {
        exporter,
        // Invalid runtime is intentional to ensure we safely skip observability.
        baseTraceId: undefined,
        sessionId: 'session-abc',
        metadata: { correlationId: 'corr-1' },
        captureMessages: 'text',
        captureToolArgs: false,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      } as any
    } as any);

    const eventsTask = collectAll(session.events());
    await session.commit();
    await eventsTask;

    expect(exporter.recordLLMRequest).not.toHaveBeenCalled();
    expect(exporter.recordLLMResponse).not.toHaveBeenCalled();
  });

  test('assistant final without prior commit does not record observability response', async () => {
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'assistant_text.final', text: 'ONE' };
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const exporter = {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      flush: jest.fn(async () => {})
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'rt_p' } as any,
      spec: {
        provider: 'rt_p',
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      } as any,
      compatSession: compat as any,
      observability: {
        exporter,
        baseTraceId: 'trace',
        sessionId: 'session-abc',
        captureMessages: 'text',
        captureToolArgs: false,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      } as any
    } as any);

    await collectAll(session.events());

    expect(exporter.recordLLMRequest).not.toHaveBeenCalled();
    expect(exporter.recordLLMResponse).not.toHaveBeenCalled();
  });

  test('injectContext maps roles and ignores missing text', async () => {
    const injected = createDeferred<void>();

    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(async () => injected.resolve()),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await injected.promise;
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'rt_p' } as any,
      spec: {
        provider: 'rt_p',
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      } as any,
      compatSession: compat as any
    } as any);

    const eventsTask = collectAll(session.events());

    await session.sendText({ text: undefined as any, role: 'system' });
    await session.sendText({ text: 'hi' } as any);

    await session.injectContext([
      { role: 'system', text: 'S' },
      { role: 'assistant', text: 'A' },
      { text: 'U' } as any,
      {} as any
    ]);

    await eventsTask;
    expect(compat.injectContext).toHaveBeenCalled();
  });

  test('records tools list and parses history roles', async () => {
    const committed = createDeferred<void>();

    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(async () => committed.resolve()),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await committed.promise;
        yield {} as any;
        yield { type: 'assistant_text.final' } as any;
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const exporter = {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      flush: jest.fn(async () => {})
    };

    const tools = [{ name: 't1', description: 'd1' }] as any;

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'rt_p' } as any,
      spec: {
        provider: 'rt_p',
        systemPrompt: 'SYS_PROMPT',
        history: [
          { role: 'system', text: 'H_SYS' },
          { role: 'assistant', text: 'H_ASSISTANT' },
          { role: 'user', text: 'H_USER' },
          {} as any
        ],
        metadata: { correlationId: 'corr-1' },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      } as any,
      compatSession: compat as any,
      tools,
      observability: {
        exporter,
        baseTraceId: 'trace',
        sessionId: 'session-abc',
        captureToolArgs: false,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      } as any
    } as any);

    const eventsTask = collectAll(session.events());
    await session.commit();
    await eventsTask;

    const req = exporter.recordLLMRequest.mock.calls[0]?.[0] as any;
    expect(req.model).toBe('rt_p');
    expect(req.metadata).toEqual({ correlationId: 'corr-1' });
    expect(req.tools).toEqual([{ name: 't1', description: 'd1' }]);

    const text = extractTextFromMessages(req.messages);
    expect(text).toContain('SYS_PROMPT');
    expect(text).toContain('H_SYS');
    expect(text).toContain('H_ASSISTANT');
    expect(text).toContain('H_USER');
  });

  test('records tool calls in response without arguments when captureToolArgs=false', async () => {
    const committed = createDeferred<void>();

    const routeAndInvoke = jest.fn(async () => ({ ok: true }));
    jest.unstable_mockModule('../../../modules/tools/index.js', () => ({
      ToolCoordinator: class {
        routeAndInvoke = routeAndInvoke;
      }
    }));

    const compatSendToolResult = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(async () => committed.resolve()),
      interrupt: jest.fn(),
      sendToolResult: compatSendToolResult,
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await committed.promise;
        yield { type: 'tool_call.end', toolCallId: 'c1', name: 'echo', arguments: { text: 'Tokyo' } } as any;
        yield { type: 'assistant_text.final', text: 'DONE' };
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const exporter = {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      flush: jest.fn(async () => {})
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'rt_p' } as any,
      spec: {
        provider: 'rt_p',
        functionToolNames: ['echo'],
        metadata: { testKey: 'testValue' },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      } as any,
      compatSession: compat as any,
      observability: {
        exporter,
        baseTraceId: 'trace',
        sessionId: 'session-abc',
        captureMessages: 'text',
        captureToolArgs: false,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      } as any
    } as any);

    const eventsTask = collectAll(session.events());
    await session.commit();
    await eventsTask;

    expect(routeAndInvoke).toHaveBeenCalledWith(
      'echo',
      'c1',
      { text: 'Tokyo' },
      expect.objectContaining({ metadata: { testKey: 'testValue' } })
    );
    expect(compatSendToolResult).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'c1' }));

    const res = exporter.recordLLMResponse.mock.calls[0]?.[0] as any;
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'echo' }]);
  });

  test('captureToolArgs=true includes arguments when defined and omits when undefined', async () => {
    const committed = createDeferred<void>();

    const routeAndInvoke = jest.fn(async () => ({ ok: true }));
    jest.unstable_mockModule('../../../modules/tools/index.js', () => ({
      ToolCoordinator: class {
        routeAndInvoke = routeAndInvoke;
      }
    }));

    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(async () => committed.resolve()),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await committed.promise;
        yield { type: 'tool_call.end', toolCallId: 'c1', name: 'echo' } as any;
        yield { type: 'tool_call.end', toolCallId: 'c2', name: 'echo', arguments: { text: 'two' } } as any;
        yield { type: 'assistant_text.final', text: 'DONE' };
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const exporter = {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      flush: jest.fn(async () => {})
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'rt_p' } as any,
      spec: {
        provider: 'rt_p',
        functionToolNames: ['echo'],
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      } as any,
      compatSession: compat as any,
      observability: {
        exporter,
        baseTraceId: 'trace',
        sessionId: 'session-abc',
        captureMessages: 'text',
        captureToolArgs: true,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      } as any
    } as any);

    const eventsTask = collectAll(session.events());
    await session.commit();
    await eventsTask;

    const res = exporter.recordLLMResponse.mock.calls[0]?.[0] as any;
    expect(res.toolCalls).toEqual([
      { id: 'c1', name: 'echo' },
      { id: 'c2', name: 'echo', arguments: { text: 'two' } }
    ]);
  });

  test('records error events as response errors', async () => {
    const turn1 = createDeferred<void>();
    const turn2 = createDeferred<void>();
    let commitCount = 0;

    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(async () => {
        commitCount += 1;
        if (commitCount === 1) turn1.resolve();
        else turn2.resolve();
      }),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await turn1.promise;
        yield { type: 'error', message: 'boom', code: 'E1' } as any;
        await turn2.promise;
        yield { type: 'error' } as any;
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const exporter = {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      flush: jest.fn(async () => {})
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'rt_p' } as any,
      spec: {
        provider: 'rt_p',
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      } as any,
      compatSession: compat as any,
      observability: {
        exporter,
        baseTraceId: 'trace',
        sessionId: 'session-abc',
        captureMessages: 'text',
        captureToolArgs: false,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      } as any
    } as any);

    const eventsTask = collectAll(session.events());
    await session.commit();
    await session.commit();
    await eventsTask;

    expect(exporter.recordLLMRequest).toHaveBeenCalledTimes(2);
    expect(exporter.recordLLMResponse).toHaveBeenCalledTimes(2);

    const res1 = exporter.recordLLMResponse.mock.calls[0]?.[0] as any;
    const res2 = exporter.recordLLMResponse.mock.calls[1]?.[0] as any;
    expect(res1.error).toEqual({ message: 'boom', code: 'E1' });
    expect(res2.error).toEqual({ message: 'error', code: undefined });
  });

  test('closing the session drains pending turns with error responses', async () => {
    const committed = createDeferred<void>();
    const closed = createDeferred<void>();

    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(async () => committed.resolve()),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(async () => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const exporter = {
      recordLLMRequest: jest.fn(),
      recordLLMResponse: jest.fn(),
      flush: jest.fn(async () => {})
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'rt_p' } as any,
      spec: {
        provider: 'rt_p',
        metadata: { correlationId: 'corr-1' },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      } as any,
      compatSession: compat as any,
      observability: {
        exporter,
        baseTraceId: 'trace',
        sessionId: 'session-abc',
        captureToolArgs: false,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      } as any
    } as any);

    const eventsTask = collectAll(session.events());
    await session.commit();
    await session.close();
    await eventsTask;

    expect(exporter.recordLLMRequest).toHaveBeenCalledTimes(1);
    expect(exporter.recordLLMResponse).toHaveBeenCalledTimes(1);

    const res = exporter.recordLLMResponse.mock.calls[0]?.[0] as any;
    expect(String(res.error?.message ?? '')).toContain('Realtime session closed before assistant response');
  });
});
