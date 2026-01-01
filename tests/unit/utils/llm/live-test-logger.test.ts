import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

function getLogFilePath(testFileName: string): string {
  const dateOnly = new Date().toISOString().split('T')[0];
  return path.join(process.cwd(), 'tests', 'live', 'logs', `${dateOnly}-${testFileName}.log`);
}

describe('modules/shared/internal/live-test-logger', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test('server transport does not truncate existing log files and redacts API keys', async () => {
    process.env.LLM_LIVE_TRANSPORT = 'server';

    await withTempCwd('live-test-logger-server-existing', async () => {
      const { logRequest } = await import('@/modules/shared/internal/live-test-logger.ts');

      const logFile = getLogFilePath('server-existing');
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, 'keep\n', 'utf-8');

      logRequest(
        {
          url: 'https://example.com',
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-abcdef1234',
            'x-api-key': 'test-zzzzyyyy1234',
            'x-goog-api-key': 'test-qqqqwwww5678'
          },
          body: { ok: true }
        },
        { testFile: 'server-existing', testName: 'server existing' }
      );

      const content = fs.readFileSync(logFile, 'utf-8');
      expect(content.startsWith('keep\n')).toBe(true);
      expect(content).toContain('--- HEADERS ---');
      expect(content).toContain('Bearer ***1234');
      expect(content).toContain('***1234');
      expect(content).toContain('***5678');
    });
  });

  test('server transport creates missing log files and tolerates missing statusText', async () => {
    process.env.LLM_LIVE_TRANSPORT = 'server';

    await withTempCwd('live-test-logger-server-missing', async () => {
      const { logResponse } = await import('@/modules/shared/internal/live-test-logger.ts');

      const logFile = getLogFilePath('server-missing');
      expect(fs.existsSync(logFile)).toBe(false);

      logResponse(
        {
          status: 200,
          statusText: undefined,
          headers: {},
          body: { ok: true }
        },
        { testFile: 'server-missing', testName: 'server missing' }
      );

      expect(fs.existsSync(logFile)).toBe(true);
      const content = fs.readFileSync(logFile, 'utf-8');
      expect(content).toContain('Status: 200 ');
    });
  });

  test('stringifyBody falls back for circular bodies and headers can be undefined', async () => {
    delete process.env.LLM_LIVE_TRANSPORT;

    await withTempCwd('live-test-logger-circular', async () => {
      const { logRequest, logResponse } = await import('@/modules/shared/internal/live-test-logger.ts');

      const circular: any = {};
      circular.self = circular;

      logRequest(
        {
          url: 'https://example.com',
          method: 'POST',
          headers: undefined as any,
          body: circular
        },
        { testFile: 'circular', testName: 'circular request' }
      );

      logResponse(
        {
          status: 201,
          statusText: 'OK',
          headers: {},
          body: circular
        },
        { testFile: 'circular', testName: 'circular response' }
      );

      const logFile = getLogFilePath('circular');
      const content = fs.readFileSync(logFile, 'utf-8');
      expect(content).toContain('--- BODY ---');
      expect(content).toContain('[object Object]');
      expect(content).toContain('Status: 201 OK');
    });
  });

  test('logObservabilityEvent writes observability event bodies', async () => {
    delete process.env.LLM_LIVE_TRANSPORT;

    await withTempCwd('live-test-logger-observability', async () => {
      const { logObservabilityEvent } = await import('@/modules/shared/internal/live-test-logger.ts');

      logObservabilityEvent(
        {
          eventType: 'LLM_REQUEST',
          traceId: 'trace-123',
          generationId: 'gen-456',
          event: {
            traceId: 'trace-123',
            generationId: 'gen-456',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
          }
        },
        { testFile: 'observability', testName: 'observability event', correlationId: 'trace-123' }
      );

      const logFile = getLogFilePath('observability');
      const content = fs.readFileSync(logFile, 'utf-8');
      expect(content).toContain('>>> OBSERVABILITY EVENT >>>');
      expect(content).toContain('Event Type: LLM_REQUEST');
      expect(content).toContain('TraceId: trace-123');
      expect(content).toContain('GenerationId: gen-456');
      expect(content).toContain('--- BODY ---');
      expect(content).toContain('"messages"');
      expect(content).toContain('hello');
    });
  });

  test('logObservabilityEvent tolerates missing correlationId/traceId/generationId', async () => {
    delete process.env.LLM_LIVE_TRANSPORT;

    await withTempCwd('live-test-logger-observability-missing', async () => {
      const { logObservabilityEvent } = await import('@/modules/shared/internal/live-test-logger.ts');

      logObservabilityEvent({
        eventType: 'LLM_REQUEST',
        event: { ok: true }
      });

      const logFile = getLogFilePath('unknown-test');
      const content = fs.readFileSync(logFile, 'utf-8');
      expect(content).toContain('>>> OBSERVABILITY EVENT >>>');
      expect(content).toContain('Event Type: LLM_REQUEST');
      expect(content).toContain('"ok": true');
      expect(content).not.toContain('CorrelationId:');
      expect(content).not.toContain('TraceId:');
      expect(content).not.toContain('GenerationId:');
    });
  });
});
