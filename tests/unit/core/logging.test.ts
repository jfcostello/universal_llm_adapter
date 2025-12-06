import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { withTempCwd } from '@tests/helpers/temp-files.ts';
import { setupLoggingTestHarness } from '@tests/helpers/logger.ts';

describe('core/logging', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('creates file and console transports with correlation metadata when file logs enabled', async () => {
    await withTempCwd('logging-file', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { AdapterLogger, LogLevel } = module;

        const logger = new AdapterLogger(LogLevel.DEBUG, 'corr-file');

        expect(mocks.dailyRotate).toHaveBeenCalledTimes(1);
        // Note: FlushingConsoleTransport is a custom class, not winston.transports.Console
        // so the consoleTransport mock is not called

        const config = mocks.getLastConfig();
        expect(config).toBeDefined();
        const transports = (config?.transports as unknown[]) ?? [];
        expect(transports).toHaveLength(2);

        const [fileTransport] = transports as Array<{ options: Record<string, unknown> }>;
        expect(fileTransport.options).toMatchObject({
          level: LogLevel.DEBUG,
          filename: expect.stringContaining('adapter-')
        });
        // Console transport is custom FlushingConsoleTransport, validated by length check above

        const logsDir = path.join(cwd, 'logs');
        expect(fs.existsSync(logsDir)).toBe(true);

        // Test both formatters - file (index 0) and console (index 1)
        const formatters = mocks.getAllPrintfFormatters();
        expect(formatters).toHaveLength(2);

        // File formatter should prefix with [timestamp]:
        const fileFormatter = formatters[0];
        const fileFormatted = fileFormatter({
          timestamp: '2025-10-18T10:00:00.000Z',
          level: 'info',
          message: 'hello',
          extra: 'value'
        });

        expect(fileFormatted).toContain('[2025-10-18T10:00:00.000Z]:');
        const fileJsonPart = fileFormatted.split(']: ')[1];
        expect(JSON.parse(fileJsonPart)).toEqual({
          level: 'info',
          message: 'hello',
          correlationId: 'corr-file',
          extra: 'value',
          timestamp: '2025-10-18T10:00:00.000Z'
        });

        const fileFormattedWithNonString = fileFormatter({
          timestamp: '2025-10-18T10:00:00.000Z',
          level: 123,
          message: { greeting: 'hi' },
          extra: 'value',
          details: { some: 'data' }
        } as any);

        const nonStringJson = JSON.parse(fileFormattedWithNonString.split(']: ')[1]);
        expect(nonStringJson.level).toBe('123');
        expect(nonStringJson.message).toBe(JSON.stringify({ greeting: 'hi' }));
        expect(nonStringJson.details).toEqual({ some: 'data' });

        const fileFormattedWithUndefined = fileFormatter({
          timestamp: '2025-10-18T10:00:00.000Z',
          level: 'warn',
          extra: 'value'
        } as any);

        const undefinedJson = JSON.parse(fileFormattedWithUndefined.split(']: ')[1]);
        expect(undefinedJson.message).toBe(JSON.stringify(''));
        expect(undefinedJson.level).toBe('warn');

        const fileMinimal = fileFormatter({
          timestamp: '2025-10-18T10:00:00.000Z',
          level: 'debug',
          message: 'no-extra'
        });

        expect(fileMinimal).toContain('[2025-10-18T10:00:00.000Z]:');
        const fileMinimalJson = fileMinimal.split(']: ')[1];
        expect(JSON.parse(fileMinimalJson)).toEqual({
          level: 'debug',
          message: 'no-extra',
          correlationId: 'corr-file',
          timestamp: '2025-10-18T10:00:00.000Z'
        });

        // Console formatter should remain as pure JSON (for backwards compatibility)
        const consoleFormatter = formatters[1];
        const consoleFormatted = consoleFormatter({
          timestamp: '2025-10-18T10:00:00.000Z',
          level: 'info',
          message: 'hello',
          extra: 'value'
        });

        expect(consoleFormatted).not.toContain('[2025-10-18T10:00:00.000Z]:');
        expect(JSON.parse(consoleFormatted)).toEqual({
          type: 'log',
          timestamp: '2025-10-18T10:00:00.000Z',
          level: 'info',
          message: 'hello',
          correlationId: 'corr-file',
          data: {
            extra: 'value',
            timestamp: '2025-10-18T10:00:00.000Z'
          }
        });

        logger.debug('dbg');
        expect(mocks.logger.debug).toHaveBeenCalledWith('dbg', {});

        logger.info('info', { foo: 'bar' });
        expect(mocks.logger.info).toHaveBeenCalledWith('info', { foo: 'bar' });

        logger.warning('warn');
        expect(mocks.logger.warn).toHaveBeenCalledWith('warn', {});

        logger.error('err', { code: 500 });
        expect(mocks.logger.error).toHaveBeenCalledWith('err', { code: 500 });

        logger.error('err-default');
        expect(mocks.logger.error).toHaveBeenCalledWith('err-default', {});

        mocks.logger.debug.mockClear();
        logger.debugRaw('raw-string');
        expect(mocks.logger.debug).toHaveBeenCalledWith('Raw payload', { raw: 'raw-string' });

        mocks.logger.debug.mockClear();
        const buffer = Buffer.from('payload');
        logger.debugRaw(buffer);
        expect(mocks.logger.debug).toHaveBeenCalledWith('Raw payload', {
          raw: JSON.stringify(buffer)
        });

        mocks.logger.debug.mockClear();
        const uint8 = new Uint8Array(buffer);
        logger.debugRaw(uint8);
        expect(mocks.logger.debug).toHaveBeenCalledWith('Raw payload', {
          raw: JSON.stringify(Buffer.from(uint8).toString('base64'))
        });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('getLogger reuses singleton logger and supports correlation instances', async () => {
    const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { getLogger } = module;

    const primary = getLogger();
    const secondary = getLogger();

    expect(secondary).toBe(primary);

    const correlated = getLogger('corr-secondary');
    expect(correlated).not.toBe(primary);

    correlated.info('message');
    expect(mocks.createLogger).toHaveBeenCalledTimes(2);
    expect(mocks.logger.info).toHaveBeenCalledWith('message', {});
  });

  test('getEmbeddingLogger/getVectorLogger return correlated instances and closeLogger closes all singletons', async () => {
    const { module } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { getLLMLogger, getEmbeddingLogger, getVectorLogger, closeLogger } = module;

    const llm = getLLMLogger();
    const llmCorr = getLLMLogger('corr-llm');
    expect(llmCorr).not.toBe(llm);

    const emb = getEmbeddingLogger();
    const embCorr = getEmbeddingLogger('corr-emb');
    expect(embCorr).not.toBe(emb);

    const vec = getVectorLogger();
    const vecCorr = getVectorLogger('corr-vec');
    expect(vecCorr).not.toBe(vec);

    const llmClose = jest.spyOn(llm, 'close').mockResolvedValue();
    const embClose = jest.spyOn(emb, 'close').mockResolvedValue();
    const vecClose = jest.spyOn(vec, 'close').mockResolvedValue();

    await closeLogger();

    expect(llmClose).toHaveBeenCalledTimes(1);
    expect(embClose).toHaveBeenCalledTimes(1);
    expect(vecClose).toHaveBeenCalledTimes(1);
  });

  test('AdapterLogger skips console transport when console logging disabled', async () => {
    await withTempCwd('logging-console-disabled', async () => {
      process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '1';
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
      jest.resetModules();
      const logging = await import('@/core/logging.ts');
      const logger = new logging.AdapterLogger(logging.LogLevel.INFO);
      expect((logger as any).logger.transports.length).toBe(0);
      delete process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
      delete process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
    });
  });

  test('AdapterLogger defaults to info level and omits correlation metadata', async () => {
    const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { AdapterLogger } = module;

    jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
    try {
      const logger = new AdapterLogger();
      logger.info('hello');
      expect(mocks.logger.info).toHaveBeenCalledWith('hello', {});

      // With file logs disabled, only console formatter exists
      const formatters = mocks.getAllPrintfFormatters();
      expect(formatters).toHaveLength(1);

      const formatter = formatters[0];
      const formatted = formatter({
        timestamp: '2025-10-18T10:00:00.000Z',
        level: 'info',
        message: 'plain'
      } as any);

      expect(JSON.parse(formatted as string)).toEqual({
        type: 'log',
        timestamp: '2025-10-18T10:00:00.000Z',
        level: 'info',
        message: 'plain',
        data: {
          timestamp: '2025-10-18T10:00:00.000Z'
        }
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('AdapterLogger.close() closes the logger instance', async () => {
    const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { AdapterLogger } = module;

    const logger = new AdapterLogger();

    // Create mock transport that emits 'finish' event
    const mockTransport = {
      once: jest.fn((event: string, callback: () => void) => {
        if (event === 'finish') {
          // Call the callback immediately to simulate finish event
          setTimeout(callback, 0);
        }
      })
    };

    mocks.logger.transports = [mockTransport];
    mocks.logger.close.mockImplementation(() => {
      // Trigger all 'finish' listeners
      mockTransport.once.mock.calls.forEach((call: any[]) => {
        if (call[0] === 'finish') {
          call[1]();
        }
      });
    });

    await logger.close();
    expect(mocks.logger.close).toHaveBeenCalledTimes(1);
  });

  test('closeLogger() closes singleton and resets it', async () => {
    const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { getLogger, closeLogger } = module;

    const logger1 = getLogger();
    logger1.info('before close');
    expect(mocks.logger.info).toHaveBeenCalledWith('before close', {});

    // Create mock transport that emits 'finish' event
    const mockTransport = {
      once: jest.fn((event: string, callback: () => void) => {
        if (event === 'finish') {
          // Call the callback immediately to simulate finish event
          setTimeout(callback, 0);
        }
      })
    };

    mocks.logger.transports = [mockTransport];
    mocks.logger.close.mockImplementation(() => {
      // Trigger all 'finish' listeners
      mockTransport.once.mock.calls.forEach((call: any[]) => {
        if (call[0] === 'finish') {
          call[1]();
        }
      });
    });

    await closeLogger();
    expect(mocks.logger.close).toHaveBeenCalledTimes(1);

    // After closing, getLogger should create a new instance
    const logger2 = getLogger();
    expect(mocks.createLogger).toHaveBeenCalledTimes(2);
  });

  test('closeLogger() is safe to call when logger is null', async () => {
    const { module } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { closeLogger } = module;

    await closeLogger();
    await closeLogger(); // calling twice should be safe
  });

  test('AdapterLogger.close() handles empty transports array', async () => {
    const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { AdapterLogger } = module;

    const logger = new AdapterLogger();

    // Ensure transports is empty (this is the default from the mock)
    expect(mocks.logger.transports).toEqual([]);

    // This should complete immediately without calling logger.close()
    await logger.close();

    // Since transports is empty, logger.close() should not be called
    expect(mocks.logger.close).not.toHaveBeenCalled();
  });

  test('AdapterLogger.close() timeout fires when transports never finish', async () => {
    const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { AdapterLogger } = module;

    const logger = new AdapterLogger();

    // Create mock transport that never emits 'finish' event
    const mockTransport = {
      once: jest.fn() // Don't call the callback - simulate hanging transport
    };

    mocks.logger.transports = [mockTransport];
    mocks.logger.close.mockImplementation(() => {
      // Don't trigger finish events - let timeout handle it
    });

    jest.useFakeTimers();
    const closePromise = logger.close();
    jest.advanceTimersByTime(2000);
    await closePromise;
    jest.useRealTimers();

    expect(mocks.logger.close).toHaveBeenCalledTimes(1);
  });

  test('LLM, embedding, and vector log directories are created lazily', async () => {
    await withTempCwd('logging-lazy-init', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { LLMLogger, EmbeddingLogger, VectorLogger, LogLevel } = module;

      const llmLogger = new LLMLogger(LogLevel.DEBUG);
      const embeddingLogger = new EmbeddingLogger(LogLevel.DEBUG);
      const vectorLogger = new VectorLogger(LogLevel.DEBUG);

      expect(fs.existsSync(path.join(cwd, 'logs', 'llm'))).toBe(false);
      expect(fs.existsSync(path.join(cwd, 'logs', 'embedding'))).toBe(false);
      expect(fs.existsSync(path.join(cwd, 'logs', 'vector'))).toBe(false);

      llmLogger.logLLMRequest({ url: 'http://lazy.llm', method: 'POST', headers: {}, body: {} });
      embeddingLogger.logEmbeddingRequest({ url: 'http://lazy.embed', method: 'POST', headers: {}, body: {} });
      vectorLogger.logVectorRequest({ operation: 'connect', store: 'lazy', params: {} });

      expect(fs.existsSync(path.join(cwd, 'logs', 'llm'))).toBe(true);
      expect(fs.existsSync(path.join(cwd, 'logs', 'embedding'))).toBe(true);
      expect(fs.existsSync(path.join(cwd, 'logs', 'vector'))).toBe(true);
    });
  });

  test('logLLMRequest writes beautifully formatted request to LLM log file', async () => {
    await withTempCwd('logging-llm-request', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { LLMLogger, LogLevel } = module;

        const logger = new LLMLogger(LogLevel.DEBUG);

        const requestData = {
          url: 'https://api.example.com/v1/chat',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer sk-test1234567890abcdef',
            'x-api-key': 'anthropic-test-key'
          },
          body: {
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'Hello' }],
            temperature: 0.7
          }
        };

        logger.logLLMRequest(requestData);

        const llmLogsDir = path.join(cwd, 'logs', 'llm');
        expect(fs.existsSync(llmLogsDir)).toBe(true);

        const logFiles = fs.readdirSync(llmLogsDir);
        expect(logFiles.length).toBe(1);
        expect(logFiles[0]).toBe('llm-2025-10-18T10-00-00-000Z.log');

        const logContent = fs.readFileSync(path.join(llmLogsDir, logFiles[0]), 'utf-8');

        // Verify the beautiful formatting
        expect(logContent).toContain('='.repeat(80));
        expect(logContent).toContain('>>> OUTGOING REQUEST >>>');
        expect(logContent).toContain('Method: POST');
        expect(logContent).toContain('URL: https://api.example.com/v1/chat');
        expect(logContent).toContain('--- HEADERS ---');
        expect(logContent).toContain('--- BODY ---');

        // Verify API key redaction (only last 4 chars shown)
        expect(logContent).toContain('Bearer ***cdef');
        expect(logContent).toContain('***-key');
        expect(logContent).not.toContain('sk-test1234567890abcdef');
        expect(logContent).not.toContain('anthropic-test-key');

        // Verify body content
        expect(logContent).toContain('"model": "gpt-4"');
        expect(logContent).toContain('"temperature": 0.7');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logLLMResponse writes beautifully formatted response to LLM log file', async () => {
    await withTempCwd('logging-llm-response', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { LLMLogger, LogLevel } = module;

        const logger = new LLMLogger(LogLevel.DEBUG);

        const responseData = {
          status: 200,
          statusText: 'OK',
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req-123'
          },
          body: {
            id: 'chatcmpl-123',
            choices: [
              {
                message: { role: 'assistant', content: 'Hello! How can I help?' },
                finish_reason: 'stop'
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
          }
        };

        logger.logLLMResponse(responseData);

        const llmLogsDir = path.join(cwd, 'logs', 'llm');
        expect(fs.existsSync(llmLogsDir)).toBe(true);

        const logFiles = fs.readdirSync(llmLogsDir);
        expect(logFiles.length).toBe(1);
        expect(logFiles[0]).toBe('llm-2025-10-18T10-00-00-000Z.log');

        const logContent = fs.readFileSync(path.join(llmLogsDir, logFiles[0]), 'utf-8');

        // Verify the beautiful formatting
        expect(logContent).toContain('='.repeat(80));
        expect(logContent).toContain('<<< INCOMING RESPONSE <<<');
        expect(logContent).toContain('Status: 200 OK');
        expect(logContent).toContain('--- HEADERS ---');
        expect(logContent).toContain('--- BODY ---');

        // Verify response content
        expect(logContent).toContain('"content-type": "application/json"');
        expect(logContent).toContain('"id": "chatcmpl-123"');
        expect(logContent).toContain('"content": "Hello! How can I help?"');
        expect(logContent).toContain('"total_tokens": 18');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logLLMRequest and logLLMResponse do nothing when file logging disabled', async () => {
    await withTempCwd('logging-llm-disabled', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: true });
      const { LLMLogger, LogLevel } = module;

      const logger = new LLMLogger(LogLevel.DEBUG);

      logger.logLLMRequest({
        url: 'https://api.example.com/v1/chat',
        method: 'POST',
        headers: {},
        body: {}
      });

      logger.logLLMResponse({
        status: 200,
        statusText: 'OK',
        headers: {},
        body: {}
      });

      const llmLogsDir = path.join(cwd, 'logs', 'llm');
      // The directory should not exist if file logging is disabled
      expect(fs.existsSync(llmLogsDir)).toBe(false);
    });
  });

  test('logLLMResponse handles missing statusText', async () => {
    await withTempCwd('logging-llm-no-status', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { LLMLogger, LogLevel } = module;

      const logger = new LLMLogger(LogLevel.DEBUG);

      const responseData = {
        status: 204,
        headers: {},
        body: {}
      };

      logger.logLLMResponse(responseData);

      const llmLogsDir = path.join(cwd, 'logs', 'llm');
      const logFiles = fs.readdirSync(llmLogsDir);
      const logContent = fs.readFileSync(path.join(llmLogsDir, logFiles[0]), 'utf-8');

      // Verify status without statusText
      expect(logContent).toContain('Status: 204 ');
      expect(logContent).not.toContain('Status: 204 undefined');
    });
  });

  test('logLLMRequest/Response include provider, model, and duration when provided', async () => {
    await withTempCwd('logging-llm-with-provider', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { LLMLogger, LogLevel } = module;

        const logger = new LLMLogger(LogLevel.DEBUG);

        logger.logLLMRequest({
          url: 'http://api.example.com',
          method: 'POST',
          headers: {},
          body: {},
          provider: 'unit-provider',
          model: 'unit-model'
        });

        logger.logLLMResponse({
          status: 201,
          statusText: 'Created',
          headers: {},
          body: { ok: true },
          duration: 123,
          provider: 'unit-provider',
          model: 'unit-model'
        });

        const llmLogsDir = path.join(cwd, 'logs', 'llm');
        const logFiles = fs.readdirSync(llmLogsDir);
        const logContent = fs.readFileSync(path.join(llmLogsDir, logFiles[0]), 'utf-8');

        expect(logContent).toContain('Provider: unit-provider');
        expect(logContent).toContain('Model: unit-model');
        expect(logContent).toContain('Duration: 123ms');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logLLMRequest appends multiple requests to same log file', async () => {
    await withTempCwd('logging-llm-multiple', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { LLMLogger, LogLevel } = module;

      const logger = new LLMLogger(LogLevel.DEBUG);

      logger.logLLMRequest({
        url: 'https://api.example.com/v1/chat',
        method: 'POST',
        headers: {},
        body: { model: 'gpt-4', message: 'first' }
      });

      logger.logLLMRequest({
        url: 'https://api.example.com/v1/chat',
        method: 'POST',
        headers: {},
        body: { model: 'gpt-4', message: 'second' }
      });

      const llmLogsDir = path.join(cwd, 'logs', 'llm');
      const logFiles = fs.readdirSync(llmLogsDir);
      expect(logFiles.length).toBe(1);

      const logContent = fs.readFileSync(path.join(llmLogsDir, logFiles[0]), 'utf-8');

      // Both requests should be in the same file
      expect(logContent).toContain('"message": "first"');
      expect(logContent).toContain('"message": "second"');

      // Should have two request separators
      const requestCount = (logContent.match(/>>> OUTGOING REQUEST >>>/g) || []).length;
      expect(requestCount).toBe(2);
    });
  });

  test('batch id routes LLM logs to single batch-named file', async () => {
    await withTempCwd('logging-llm-batch', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_demo_123';
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { LLMLogger, LogLevel } = module;

      const logger = new LLMLogger(LogLevel.DEBUG);
      logger.logLLMRequest({ url: 'http://ex', method: 'POST', headers: {}, body: { ok: true } });

      const llmLogsDir = path.join(cwd, 'logs', 'llm');
      const files = fs.readdirSync(llmLogsDir);
      expect(files).toEqual(['llm-batch-batch_demo_123.log']);

      const content = fs.readFileSync(path.join(llmLogsDir, files[0]), 'utf-8');
      expect(content).toContain('>>> OUTGOING REQUEST >>>');

      // Clean env for subsequent tests
      delete process.env.LLM_ADAPTER_BATCH_ID;
    });
  });

  test('file transport filename includes adapter-batch prefix when batch id set', async () => {
    await withTempCwd('logging-rotate-batch', async () => {
      process.env.LLM_ADAPTER_BATCH_ID = 'caseX';
      const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { AdapterLogger, LogLevel } = module;

      new AdapterLogger(LogLevel.DEBUG);

      expect(mocks.fileTransport).toHaveBeenCalledTimes(1);
      expect(mocks.dailyRotate).not.toHaveBeenCalled();

      const config = mocks.getLastConfig();
      const transports = (config?.transports as any[]) ?? [];
      const [fileTransport] = transports as Array<{ options: Record<string, unknown> }>;
      expect(String(fileTransport.options.filename)).toContain('adapter-batch-caseX.log');
      expect(fileTransport.options.maxsize).toBe(5 * 1024 * 1024);
      expect(fileTransport.options.maxFiles).toBe(50);

      delete process.env.LLM_ADAPTER_BATCH_ID;
    });
  });

  test('batch dir mode writes under logs/llm/batch-<id>/llm.log', async () => {
    await withTempCwd('logging-llm-batchdir', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'dircase';
      process.env.LLM_ADAPTER_BATCH_DIR = '1';
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { LLMLogger, LogLevel } = module;

      const logger = new LLMLogger(LogLevel.DEBUG);
      logger.logLLMResponse({ status: 200, headers: {}, body: { ok: true } });

      const dir = path.join(cwd, 'logs', 'llm', 'batch-dircase');
      const files = fs.readdirSync(dir);
      expect(files).toContain('llm.log');

      delete process.env.LLM_ADAPTER_BATCH_ID;
      delete process.env.LLM_ADAPTER_BATCH_DIR;
    });
  });

  test('AdapterLogger.error normalizes array payloads and string inputs', async () => {
    const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { AdapterLogger } = module;

    const logger = new AdapterLogger();

    const payload = [new Error('broken'), { code: 500 }, 'plain'];
    logger.error('array-case', payload);

    const arrayCall = mocks.logger.error.mock.calls.find(call => call[0] === 'array-case');
    expect(arrayCall).toBeDefined();
    const normalized = arrayCall?.[1];
    expect(Array.isArray(normalized)).toBe(true);
    expect(normalized?.[0]).toMatchObject({
      name: 'Error',
      message: 'broken'
    });
    expect(normalized?.[1]).toEqual({ code: 500 });
    expect(normalized?.[2]).toBe('plain');

    logger.error('string-case', 'fatal');
    const stringCall = mocks.logger.error.mock.calls.find(call => call[0] === 'string-case');
    expect(stringCall?.[1]).toEqual({ error: 'fatal' });
  });

  test('AdapterLogger.error normalizes nested Error properties within objects', async () => {
    const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { AdapterLogger } = module;

    const logger = new AdapterLogger();
    logger.error('object-case', {
      reason: new Error('failure'),
      context: { retry: true }
    });

    const objectCall = mocks.logger.error.mock.calls.find(call => call[0] === 'object-case');
    expect(objectCall?.[1]).toMatchObject({
      reason: { name: 'Error', message: 'failure' },
      context: { retry: true }
    });
  });

  test('AdapterLogger.error handles errors without stack traces', async () => {
    const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { AdapterLogger } = module;

    const logger = new AdapterLogger();
    const err = new Error('missing stack');
    delete err.stack;

    logger.error('nostack', err);

    const call = mocks.logger.error.mock.calls.find(([message]) => message === 'nostack');
    expect(call?.[1]).toMatchObject({
      error: {
        name: 'Error',
        message: 'missing stack',
        stack: undefined
      }
    });
  });

  test('logEmbeddingRequest writes beautifully formatted request to embedding log file', async () => {
    await withTempCwd('logging-embedding-request', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { EmbeddingLogger, LogLevel } = module;

        const logger = new EmbeddingLogger(LogLevel.DEBUG);

        const requestData = {
          url: 'https://api.openrouter.ai/v1/embeddings',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer sk-or-test1234567890abcdef'
          },
          body: {
            model: 'text-embedding-3-small',
            input: ['Hello world']
          },
          provider: 'openrouter',
          model: 'text-embedding-3-small'
        };

        logger.logEmbeddingRequest(requestData);

        const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
        expect(fs.existsSync(embeddingLogsDir)).toBe(true);

        const logFiles = fs.readdirSync(embeddingLogsDir);
        expect(logFiles.length).toBe(1);
        expect(logFiles[0]).toBe('embedding-2025-10-18T10-00-00-000Z.log');

        const logContent = fs.readFileSync(path.join(embeddingLogsDir, logFiles[0]), 'utf-8');

        // Verify the beautiful formatting
        expect(logContent).toContain('='.repeat(80));
        expect(logContent).toContain('>>> EMBEDDING REQUEST >>>');
        expect(logContent).toContain('Provider: openrouter');
        expect(logContent).toContain('Model: text-embedding-3-small');
        expect(logContent).toContain('Method: POST');
        expect(logContent).toContain('URL: https://api.openrouter.ai/v1/embeddings');
        expect(logContent).toContain('--- HEADERS ---');
        expect(logContent).toContain('--- BODY ---');

        // Verify API key redaction
        expect(logContent).toContain('Bearer ***cdef');
        expect(logContent).not.toContain('sk-or-test1234567890abcdef');

        // Verify body content
        expect(logContent).toContain('"model": "text-embedding-3-small"');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logEmbeddingResponse writes beautifully formatted response to embedding log file', async () => {
    await withTempCwd('logging-embedding-response', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { EmbeddingLogger, LogLevel } = module;

        const logger = new EmbeddingLogger(LogLevel.DEBUG);

        const responseData = {
          status: 200,
          statusText: 'OK',
          headers: {
            'content-type': 'application/json'
          },
          body: {
            data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
            model: 'text-embedding-3-small',
            usage: { prompt_tokens: 5, total_tokens: 5 }
          },
          dimensions: 3,
          tokenCount: 5
        };

        logger.logEmbeddingResponse(responseData);

        const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
        expect(fs.existsSync(embeddingLogsDir)).toBe(true);

        const logFiles = fs.readdirSync(embeddingLogsDir);
        expect(logFiles.length).toBe(1);

        const logContent = fs.readFileSync(path.join(embeddingLogsDir, logFiles[0]), 'utf-8');

        // Verify the beautiful formatting
        expect(logContent).toContain('='.repeat(80));
        expect(logContent).toContain('<<< EMBEDDING RESPONSE <<<');
        expect(logContent).toContain('Status: 200 OK');
        expect(logContent).toContain('Dimensions: 3');
        expect(logContent).toContain('Token Count: 5');
        expect(logContent).toContain('--- HEADERS ---');
        expect(logContent).toContain('--- BODY ---');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logEmbeddingRequest and logEmbeddingResponse do nothing when file logging disabled', async () => {
    await withTempCwd('logging-embedding-disabled', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: true });
      const { EmbeddingLogger, LogLevel } = module;

      const logger = new EmbeddingLogger(LogLevel.DEBUG);

      logger.logEmbeddingRequest({
        url: 'https://api.example.com/v1/embeddings',
        method: 'POST',
        headers: {},
        body: {}
      });

      logger.logEmbeddingResponse({
        status: 200,
        statusText: 'OK',
        headers: {},
        body: {}
      });

      const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
      expect(fs.existsSync(embeddingLogsDir)).toBe(false);
    });
  });

  test('logVectorRequest writes beautifully formatted request to vector log file', async () => {
    await withTempCwd('logging-vector-request', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { VectorLogger, LogLevel } = module;

        const logger = new VectorLogger(LogLevel.DEBUG);

        const requestData = {
          operation: 'query',
          store: 'qdrant-cloud',
          collection: 'documents',
          params: {
            vectorDimensions: 1536,
            topK: 5,
            filter: { topic: 'geography' }
          }
        };

        logger.logVectorRequest(requestData);

        const vectorLogsDir = path.join(cwd, 'logs', 'vector');
        expect(fs.existsSync(vectorLogsDir)).toBe(true);

        const logFiles = fs.readdirSync(vectorLogsDir);
        expect(logFiles.length).toBe(1);
        expect(logFiles[0]).toBe('vector-2025-10-18T10-00-00-000Z.log');

        const logContent = fs.readFileSync(path.join(vectorLogsDir, logFiles[0]), 'utf-8');

        // Verify the beautiful formatting
        expect(logContent).toContain('='.repeat(80));
        expect(logContent).toContain('>>> VECTOR OPERATION: query >>>');
        expect(logContent).toContain('Store: qdrant-cloud');
        expect(logContent).toContain('Collection: documents');
        expect(logContent).toContain('--- PARAMS ---');
        expect(logContent).toContain('"vectorDimensions": 1536');
        expect(logContent).toContain('"topK": 5');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logVectorResponse writes beautifully formatted response to vector log file', async () => {
    await withTempCwd('logging-vector-response', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { VectorLogger, LogLevel } = module;

        const logger = new VectorLogger(LogLevel.DEBUG);

        const responseData = {
          operation: 'query',
          store: 'qdrant-cloud',
          collection: 'documents',
          result: {
            count: 3,
            topScore: 0.92,
            ids: ['fact-1', 'fact-4', 'fact-2']
          },
          duration: 45
        };

        logger.logVectorResponse(responseData);

        const vectorLogsDir = path.join(cwd, 'logs', 'vector');
        expect(fs.existsSync(vectorLogsDir)).toBe(true);

        const logFiles = fs.readdirSync(vectorLogsDir);
        expect(logFiles.length).toBe(1);

        const logContent = fs.readFileSync(path.join(vectorLogsDir, logFiles[0]), 'utf-8');

        // Verify the beautiful formatting
        expect(logContent).toContain('='.repeat(80));
        expect(logContent).toContain('<<< VECTOR RESULT: query <<<');
        expect(logContent).toContain('Store: qdrant-cloud');
        expect(logContent).toContain('Collection: documents');
        expect(logContent).toContain('Duration: 45ms');
        expect(logContent).toContain('--- RESULT ---');
        expect(logContent).toContain('"count": 3');
        expect(logContent).toContain('"topScore": 0.92');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logVectorRequest and logVectorResponse do nothing when file logging disabled', async () => {
    await withTempCwd('logging-vector-disabled', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: true });
      const { VectorLogger, LogLevel } = module;

      const logger = new VectorLogger(LogLevel.DEBUG);

      logger.logVectorRequest({
        operation: 'query',
        store: 'test-store',
        params: {}
      });

      logger.logVectorResponse({
        operation: 'query',
        store: 'test-store',
        result: {}
      });

      const vectorLogsDir = path.join(cwd, 'logs', 'vector');
      expect(fs.existsSync(vectorLogsDir)).toBe(false);
    });
  });

  test('logVectorRequest without collection omits collection field', async () => {
    await withTempCwd('logging-vector-no-collection', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VectorLogger, LogLevel } = module;

      const logger = new VectorLogger(LogLevel.DEBUG);

      logger.logVectorRequest({
        operation: 'connect',
        store: 'test-store',
        params: { url: 'http://localhost:6333' }
      });

      const vectorLogsDir = path.join(cwd, 'logs', 'vector');
      const logFiles = fs.readdirSync(vectorLogsDir);
      const logContent = fs.readFileSync(path.join(vectorLogsDir, logFiles[0]), 'utf-8');

      expect(logContent).toContain('Store: test-store');
      expect(logContent).not.toContain('Collection:');
    });
  });

  test('logVectorResponse without duration omits duration field', async () => {
    await withTempCwd('logging-vector-no-duration', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VectorLogger, LogLevel } = module;

      const logger = new VectorLogger(LogLevel.DEBUG);

      logger.logVectorResponse({
        operation: 'upsert',
        store: 'test-store',
        result: { success: true }
      });

      const vectorLogsDir = path.join(cwd, 'logs', 'vector');
      const logFiles = fs.readdirSync(vectorLogsDir);
      const logContent = fs.readFileSync(path.join(vectorLogsDir, logFiles[0]), 'utf-8');

      expect(logContent).not.toContain('Duration:');
    });
  });

  test('retention helpers handle missing log files without exclude entries', async () => {
    await withTempCwd('logging-retention-missing-file', async () => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { LLMLogger, EmbeddingLogger, VectorLogger, LogLevel } = module;

      const llmLogger = new LLMLogger(LogLevel.DEBUG);
      const embeddingLogger = new EmbeddingLogger(LogLevel.DEBUG);
      const vectorLogger = new VectorLogger(LogLevel.DEBUG);

      // Simulate missing log files and re-run retention to cover fallback branch
      (llmLogger as any).llmLogFile = undefined;
      (llmLogger as any).llmRetentionApplied = false;
      (llmLogger as any).applyLlmRetentionOnce();

      (embeddingLogger as any).embeddingLogFile = undefined;
      (embeddingLogger as any).embeddingRetentionApplied = false;
      (embeddingLogger as any).applyEmbeddingRetentionOnce();

      (vectorLogger as any).vectorLogFile = undefined;
      (vectorLogger as any).vectorRetentionApplied = false;
      (vectorLogger as any).applyVectorRetentionOnce();
    });
  });

  test('logEmbeddingRequest without provider/model omits those fields', async () => {
    await withTempCwd('logging-embedding-minimal', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { EmbeddingLogger, LogLevel } = module;

      const logger = new EmbeddingLogger(LogLevel.DEBUG);

      logger.logEmbeddingRequest({
        url: 'https://api.example.com/v1/embeddings',
        method: 'POST',
        headers: {},
        body: { input: ['test'] }
      });

      const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
      const logFiles = fs.readdirSync(embeddingLogsDir);
      const logContent = fs.readFileSync(path.join(embeddingLogsDir, logFiles[0]), 'utf-8');

      expect(logContent).not.toContain('Provider:');
      expect(logContent).not.toContain('Model:');
    });
  });

  test('logEmbeddingResponse without dimensions/tokenCount omits those fields', async () => {
    await withTempCwd('logging-embedding-no-meta', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { EmbeddingLogger, LogLevel } = module;

      const logger = new EmbeddingLogger(LogLevel.DEBUG);

      logger.logEmbeddingResponse({
        status: 200,
        headers: {},
        body: {}
      });

      const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
      const logFiles = fs.readdirSync(embeddingLogsDir);
      const logContent = fs.readFileSync(path.join(embeddingLogsDir, logFiles[0]), 'utf-8');

      expect(logContent).not.toContain('Dimensions:');
      expect(logContent).not.toContain('Token Count:');
    });
  });

  test('batch id routes embedding logs to single batch-named file', async () => {
    await withTempCwd('logging-embedding-batch', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_embed_123';
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { EmbeddingLogger, LogLevel } = module;

      const logger = new EmbeddingLogger(LogLevel.DEBUG);
      logger.logEmbeddingRequest({ url: 'http://ex', method: 'POST', headers: {}, body: { ok: true } });

      const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
      const files = fs.readdirSync(embeddingLogsDir);
      expect(files).toEqual(['embedding-batch-batch_embed_123.log']);

      delete process.env.LLM_ADAPTER_BATCH_ID;
    });
  });

  test('batch id routes vector logs to single batch-named file', async () => {
    await withTempCwd('logging-vector-batch', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_vector_123';
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VectorLogger, LogLevel } = module;

      const logger = new VectorLogger(LogLevel.DEBUG);
      logger.logVectorRequest({ operation: 'query', store: 'test', params: {} });

      const vectorLogsDir = path.join(cwd, 'logs', 'vector');
      const files = fs.readdirSync(vectorLogsDir);
      expect(files).toEqual(['vector-batch-batch_vector_123.log']);

      delete process.env.LLM_ADAPTER_BATCH_ID;
    });
  });

  test('batch dir mode writes embedding logs under logs/embedding/batch-<id>/embedding.log', async () => {
    await withTempCwd('logging-embedding-batchdir', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'embeddircase';
      process.env.LLM_ADAPTER_BATCH_DIR = '1';
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { EmbeddingLogger, LogLevel } = module;

      const logger = new EmbeddingLogger(LogLevel.DEBUG);
      logger.logEmbeddingResponse({ status: 200, headers: {}, body: { ok: true } });

      const dir = path.join(cwd, 'logs', 'embedding', 'batch-embeddircase');
      const files = fs.readdirSync(dir);
      expect(files).toContain('embedding.log');

      delete process.env.LLM_ADAPTER_BATCH_ID;
      delete process.env.LLM_ADAPTER_BATCH_DIR;
    });
  });

  test('batch dir mode writes vector logs under logs/vector/batch-<id>/vector.log', async () => {
    await withTempCwd('logging-vector-batchdir', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'vecdircase';
      process.env.LLM_ADAPTER_BATCH_DIR = '1';
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VectorLogger, LogLevel } = module;

      const logger = new VectorLogger(LogLevel.DEBUG);
      logger.logVectorResponse({ operation: 'upsert', store: 'test', result: { ok: true } });

      const dir = path.join(cwd, 'logs', 'vector', 'batch-vecdircase');
      const files = fs.readdirSync(dir);
      expect(files).toContain('vector.log');

      delete process.env.LLM_ADAPTER_BATCH_ID;
      delete process.env.LLM_ADAPTER_BATCH_DIR;
    });
  });

  test('retention match callback runs for pre-existing embedding timestamped logs', async () => {
    await withTempCwd('logging-embedding-retention', async (cwd) => {
      // Create logs/embedding directory with pre-existing log files
      const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
      fs.mkdirSync(embeddingLogsDir, { recursive: true });

      // Create pre-existing log files that match the retention pattern
      fs.writeFileSync(path.join(embeddingLogsDir, 'embedding-2025-01-01T00-00-00-000Z.log'), 'old log');
      fs.writeFileSync(path.join(embeddingLogsDir, 'embedding-2025-01-02T00-00-00-000Z.log'), 'older log');
      fs.writeFileSync(path.join(embeddingLogsDir, 'unrelated-file.txt'), 'not a log');

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { EmbeddingLogger, LogLevel } = module;

      const logger = new EmbeddingLogger(LogLevel.DEBUG);

      // Verify old files are still there (retention doesn't delete when under limit)
      expect(fs.existsSync(path.join(embeddingLogsDir, 'embedding-2025-01-01T00-00-00-000Z.log'))).toBe(true);
      expect(fs.existsSync(path.join(embeddingLogsDir, 'unrelated-file.txt'))).toBe(true);

      // Write something to verify logger works
      logger.logEmbeddingRequest({ url: 'http://test', method: 'POST', headers: {}, body: {} });
    });
  });

  test('retention match callback runs for pre-existing vector timestamped logs', async () => {
    await withTempCwd('logging-vector-retention', async (cwd) => {
      // Create logs/vector directory with pre-existing log files
      const vectorLogsDir = path.join(cwd, 'logs', 'vector');
      fs.mkdirSync(vectorLogsDir, { recursive: true });

      // Create pre-existing log files that match the retention pattern
      fs.writeFileSync(path.join(vectorLogsDir, 'vector-2025-01-01T00-00-00-000Z.log'), 'old log');
      fs.writeFileSync(path.join(vectorLogsDir, 'vector-2025-01-02T00-00-00-000Z.log'), 'older log');
      fs.writeFileSync(path.join(vectorLogsDir, 'unrelated-file.txt'), 'not a log');

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VectorLogger, LogLevel } = module;

      const logger = new VectorLogger(LogLevel.DEBUG);

      // Verify old files are still there (retention doesn't delete when under limit)
      expect(fs.existsSync(path.join(vectorLogsDir, 'vector-2025-01-01T00-00-00-000Z.log'))).toBe(true);
      expect(fs.existsSync(path.join(vectorLogsDir, 'unrelated-file.txt'))).toBe(true);

      // Write something to verify logger works
      logger.logVectorRequest({ operation: 'query', store: 'test', params: {} });
    });
  });

  test('retention match callback runs for pre-existing embedding batch logs', async () => {
    await withTempCwd('logging-embedding-batch-retention', async (cwd) => {
      // Create logs/embedding directory with pre-existing batch log files
      const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
      fs.mkdirSync(embeddingLogsDir, { recursive: true });

      // Create pre-existing batch log files that match the retention pattern
      fs.writeFileSync(path.join(embeddingLogsDir, 'embedding-batch-old1.log'), 'old batch log');
      fs.writeFileSync(path.join(embeddingLogsDir, 'embedding-batch-old2.log'), 'older batch log');
      fs.writeFileSync(path.join(embeddingLogsDir, 'embedding-2025-01-01.log'), 'timestamped log');

      process.env.LLM_ADAPTER_BATCH_ID = 'newbatch';
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { EmbeddingLogger, LogLevel } = module;

      const logger = new EmbeddingLogger(LogLevel.DEBUG);

      // Verify old batch files are still there (retention doesn't delete when under limit)
      expect(fs.existsSync(path.join(embeddingLogsDir, 'embedding-batch-old1.log'))).toBe(true);

      logger.logEmbeddingRequest({ url: 'http://test', method: 'POST', headers: {}, body: {} });

      delete process.env.LLM_ADAPTER_BATCH_ID;
    });
  });

  test('retention match callback runs for pre-existing vector batch logs', async () => {
    await withTempCwd('logging-vector-batch-retention', async (cwd) => {
      // Create logs/vector directory with pre-existing batch log files
      const vectorLogsDir = path.join(cwd, 'logs', 'vector');
      fs.mkdirSync(vectorLogsDir, { recursive: true });

      // Create pre-existing batch log files that match the retention pattern
      fs.writeFileSync(path.join(vectorLogsDir, 'vector-batch-old1.log'), 'old batch log');
      fs.writeFileSync(path.join(vectorLogsDir, 'vector-batch-old2.log'), 'older batch log');
      fs.writeFileSync(path.join(vectorLogsDir, 'vector-2025-01-01.log'), 'timestamped log');

      process.env.LLM_ADAPTER_BATCH_ID = 'newbatch';
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VectorLogger, LogLevel } = module;

      const logger = new VectorLogger(LogLevel.DEBUG);

      // Verify old batch files are still there (retention doesn't delete when under limit)
      expect(fs.existsSync(path.join(vectorLogsDir, 'vector-batch-old1.log'))).toBe(true);

      logger.logVectorRequest({ operation: 'query', store: 'test', params: {} });

      delete process.env.LLM_ADAPTER_BATCH_ID;
    });
  });

  test('embedding retention only applies once on multiple logs', async () => {
    await withTempCwd('logging-embedding-once', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { EmbeddingLogger, LogLevel } = module;

      const logger = new EmbeddingLogger(LogLevel.DEBUG);

      // Log multiple times - retention should only be applied once (second call hits early return)
      logger.logEmbeddingRequest({ url: 'http://test', method: 'POST', headers: {}, body: {} });
      logger.logEmbeddingRequest({ url: 'http://test2', method: 'POST', headers: {}, body: {} });
      logger.logEmbeddingResponse({ status: 200, headers: {}, body: {} });

      const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
      const files = fs.readdirSync(embeddingLogsDir);
      expect(files.length).toBe(1);
    });
  });

  test('vector retention only applies once on multiple logs', async () => {
    await withTempCwd('logging-vector-once', async (cwd) => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VectorLogger, LogLevel } = module;

      const logger = new VectorLogger(LogLevel.DEBUG);

      // Log multiple times - retention should only be applied once (second call hits early return)
      logger.logVectorRequest({ operation: 'query', store: 'test', params: {} });
      logger.logVectorRequest({ operation: 'upsert', store: 'test', params: {} });
      logger.logVectorResponse({ operation: 'query', store: 'test', result: {} });

      const vectorLogsDir = path.join(cwd, 'logs', 'vector');
      const files = fs.readdirSync(vectorLogsDir);
      expect(files.length).toBe(1);
    });
  });

  // ============================================================================
  // Array correlationId tests
  // ============================================================================

  test('supports array correlationId in file and console formatters', async () => {
    await withTempCwd('logging-array-correlation', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { AdapterLogger, LogLevel } = module;

        const logger = new AdapterLogger(LogLevel.DEBUG, ['session-abc', 'thread-123']);

        const formatters = mocks.getAllPrintfFormatters();
        expect(formatters).toHaveLength(2);

        // File formatter should output array correlationId
        const fileFormatter = formatters[0];
        const fileFormatted = fileFormatter({
          timestamp: '2025-10-18T10:00:00.000Z',
          level: 'info',
          message: 'test-message'
        });

        const fileJsonPart = fileFormatted.split(']: ')[1];
        const fileParsed = JSON.parse(fileJsonPart);
        expect(fileParsed.correlationId).toEqual(['session-abc', 'thread-123']);

        // Console formatter should output array correlationId
        const consoleFormatter = formatters[1];
        const consoleFormatted = consoleFormatter({
          timestamp: '2025-10-18T10:00:00.000Z',
          level: 'info',
          message: 'test-message'
        });

        const consoleParsed = JSON.parse(consoleFormatted);
        expect(consoleParsed.correlationId).toEqual(['session-abc', 'thread-123']);

        logger.info('test');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('withCorrelation supports array correlationId', async () => {
    const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { getLogger } = module;

    const primary = getLogger();
    const correlated = primary.withCorrelation(['session-abc', 'thread-123', 'request-456']);

    expect(correlated).not.toBe(primary);

    // Verify the formatter receives the array
    const formatters = mocks.getAllPrintfFormatters();
    const consoleFormatter = formatters[formatters.length - 1];
    const formatted = consoleFormatter({
      timestamp: '2025-10-18T10:00:00.000Z',
      level: 'info',
      message: 'test'
    });

    const parsed = JSON.parse(formatted);
    expect(parsed.correlationId).toEqual(['session-abc', 'thread-123', 'request-456']);
  });

  test('empty array correlationId omits correlationId field', async () => {
    await withTempCwd('logging-empty-array-correlation', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module, mocks } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { AdapterLogger, LogLevel } = module;

        const logger = new AdapterLogger(LogLevel.DEBUG, []);

        const formatters = mocks.getAllPrintfFormatters();

        // File formatter should NOT include correlationId for empty array
        const fileFormatter = formatters[0];
        const fileFormatted = fileFormatter({
          timestamp: '2025-10-18T10:00:00.000Z',
          level: 'info',
          message: 'test-message'
        });

        const fileJsonPart = fileFormatted.split(']: ')[1];
        const fileParsed = JSON.parse(fileJsonPart);
        expect(fileParsed.correlationId).toBeUndefined();

        // Console formatter should NOT include correlationId for empty array
        const consoleFormatter = formatters[1];
        const consoleFormatted = consoleFormatter({
          timestamp: '2025-10-18T10:00:00.000Z',
          level: 'info',
          message: 'test-message'
        });

        const consoleParsed = JSON.parse(consoleFormatted);
        expect(consoleParsed.correlationId).toBeUndefined();

        logger.info('test');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ============================================================================
  // CorrelationId in detail logs tests
  // ============================================================================

  test('logLLMRequest includes correlationId in detail log', async () => {
    await withTempCwd('logging-llm-correlation', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { LLMLogger, LogLevel } = module;

        const logger = new LLMLogger(LogLevel.DEBUG, 'single-corr-id');

        logger.logLLMRequest({
          url: 'https://api.example.com/v1/chat',
          method: 'POST',
          headers: {},
          body: { model: 'test' }
        });

        const llmLogsDir = path.join(cwd, 'logs', 'llm');
        const logFiles = fs.readdirSync(llmLogsDir);
        const logContent = fs.readFileSync(path.join(llmLogsDir, logFiles[0]), 'utf-8');

        expect(logContent).toContain('CorrelationId: single-corr-id');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logLLMRequest includes array correlationId as comma-separated in detail log', async () => {
    await withTempCwd('logging-llm-array-correlation', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { LLMLogger, LogLevel } = module;

        const logger = new LLMLogger(LogLevel.DEBUG, ['session-abc', 'thread-123']);

        logger.logLLMRequest({
          url: 'https://api.example.com/v1/chat',
          method: 'POST',
          headers: {},
          body: { model: 'test' }
        });

        const llmLogsDir = path.join(cwd, 'logs', 'llm');
        const logFiles = fs.readdirSync(llmLogsDir);
        const logContent = fs.readFileSync(path.join(llmLogsDir, logFiles[0]), 'utf-8');

        expect(logContent).toContain('CorrelationId: session-abc, thread-123');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logLLMResponse includes correlationId in detail log', async () => {
    await withTempCwd('logging-llm-response-correlation', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { LLMLogger, LogLevel } = module;

        const logger = new LLMLogger(LogLevel.DEBUG, ['session-abc', 'thread-123']);

        logger.logLLMResponse({
          status: 200,
          statusText: 'OK',
          headers: {},
          body: { ok: true }
        });

        const llmLogsDir = path.join(cwd, 'logs', 'llm');
        const logFiles = fs.readdirSync(llmLogsDir);
        const logContent = fs.readFileSync(path.join(llmLogsDir, logFiles[0]), 'utf-8');

        expect(logContent).toContain('CorrelationId: session-abc, thread-123');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logLLMRequest omits correlationId line when not set', async () => {
    await withTempCwd('logging-llm-no-correlation', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { LLMLogger, LogLevel } = module;

        const logger = new LLMLogger(LogLevel.DEBUG);

        logger.logLLMRequest({
          url: 'https://api.example.com/v1/chat',
          method: 'POST',
          headers: {},
          body: { model: 'test' }
        });

        const llmLogsDir = path.join(cwd, 'logs', 'llm');
        const logFiles = fs.readdirSync(llmLogsDir);
        const logContent = fs.readFileSync(path.join(llmLogsDir, logFiles[0]), 'utf-8');

        expect(logContent).not.toContain('CorrelationId:');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logLLMRequest omits correlationId line when empty array', async () => {
    await withTempCwd('logging-llm-empty-array-correlation', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { LLMLogger, LogLevel } = module;

        const logger = new LLMLogger(LogLevel.DEBUG, []);

        logger.logLLMRequest({
          url: 'https://api.example.com/v1/chat',
          method: 'POST',
          headers: {},
          body: { model: 'test' }
        });

        const llmLogsDir = path.join(cwd, 'logs', 'llm');
        const logFiles = fs.readdirSync(llmLogsDir);
        const logContent = fs.readFileSync(path.join(llmLogsDir, logFiles[0]), 'utf-8');

        expect(logContent).not.toContain('CorrelationId:');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logEmbeddingRequest includes correlationId in detail log', async () => {
    await withTempCwd('logging-embedding-correlation', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { EmbeddingLogger, LogLevel } = module;

        const logger = new EmbeddingLogger(LogLevel.DEBUG, ['embed-session', 'embed-thread']);

        logger.logEmbeddingRequest({
          url: 'https://api.example.com/v1/embeddings',
          method: 'POST',
          headers: {},
          body: { input: ['test'] }
        });

        const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
        const logFiles = fs.readdirSync(embeddingLogsDir);
        const logContent = fs.readFileSync(path.join(embeddingLogsDir, logFiles[0]), 'utf-8');

        expect(logContent).toContain('CorrelationId: embed-session, embed-thread');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logEmbeddingResponse includes correlationId in detail log', async () => {
    await withTempCwd('logging-embedding-response-correlation', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { EmbeddingLogger, LogLevel } = module;

        const logger = new EmbeddingLogger(LogLevel.DEBUG, 'single-embed-corr');

        logger.logEmbeddingResponse({
          status: 200,
          statusText: 'OK',
          headers: {},
          body: { data: [] }
        });

        const embeddingLogsDir = path.join(cwd, 'logs', 'embedding');
        const logFiles = fs.readdirSync(embeddingLogsDir);
        const logContent = fs.readFileSync(path.join(embeddingLogsDir, logFiles[0]), 'utf-8');

        expect(logContent).toContain('CorrelationId: single-embed-corr');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logVectorRequest includes correlationId in detail log', async () => {
    await withTempCwd('logging-vector-correlation', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { VectorLogger, LogLevel } = module;

        const logger = new VectorLogger(LogLevel.DEBUG, ['vec-session', 'vec-thread']);

        logger.logVectorRequest({
          operation: 'query',
          store: 'test-store',
          collection: 'docs',
          params: { topK: 5 }
        });

        const vectorLogsDir = path.join(cwd, 'logs', 'vector');
        const logFiles = fs.readdirSync(vectorLogsDir);
        const logContent = fs.readFileSync(path.join(vectorLogsDir, logFiles[0]), 'utf-8');

        expect(logContent).toContain('CorrelationId: vec-session, vec-thread');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('logVectorResponse includes correlationId in detail log', async () => {
    await withTempCwd('logging-vector-response-correlation', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      try {
        const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
        const { VectorLogger, LogLevel } = module;

        const logger = new VectorLogger(LogLevel.DEBUG, 'single-vec-corr');

        logger.logVectorResponse({
          operation: 'query',
          store: 'test-store',
          result: { count: 3 }
        });

        const vectorLogsDir = path.join(cwd, 'logs', 'vector');
        const logFiles = fs.readdirSync(vectorLogsDir);
        const logContent = fs.readFileSync(path.join(vectorLogsDir, logFiles[0]), 'utf-8');

        expect(logContent).toContain('CorrelationId: single-vec-corr');
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
