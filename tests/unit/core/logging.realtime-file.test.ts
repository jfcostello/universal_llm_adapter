import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { withTempCwd } from '@tests/helpers/temp-files.ts';
import { setupLoggingTestHarness } from '@tests/helpers/logger.ts';

describe('core/logging realtime file logs', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('RealtimeLogger writes redacted JSON lines to logs/realtime', async () => {
    await withTempCwd('realtime-logger-file', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.info('realtime.test', { systemPrompt: 'TOP_SECRET', dataBase64: 'AA==' });
      await logger.close();

      const dir = path.join(cwd, 'logs', 'realtime');
      const files = fs.readdirSync(dir);
      const file = files.find(f => /^realtime-.*\.log$/.test(f));
      expect(file).toBeTruthy();

      const content = fs.readFileSync(path.join(dir, file as string), 'utf-8');
      expect(content).toContain('realtime.test');
      expect(content).toContain('TOP_SECRET');
      expect(content).toContain('[REDACTED_BASE64]');
      expect(content).not.toContain('AA==');
    });
  });

  test('RealtimeLogger uses batch dir when LLM_ADAPTER_BATCH_DIR=1', async () => {
    await withTempCwd('realtime-logger-batch-dir', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_1';
      process.env.LLM_ADAPTER_BATCH_DIR = '1';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.info('realtime.test', { systemPrompt: 'TOP_SECRET' });
      await logger.close();

      const expected = path.join(cwd, 'logs', 'realtime', 'batch-batch_1', 'realtime.log');
      expect(fs.existsSync(expected)).toBe(true);
      expect(fs.readFileSync(expected, 'utf-8')).toContain('realtime.test');
    });
  });

  test('RealtimeLogger rotates batch logs when max-bytes is exceeded', async () => {
    await withTempCwd('realtime-logger-rotate-bytes', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_1';
      process.env.LLM_ADAPTER_BATCH_DIR = '1';
      process.env.LLM_ADAPTER_REALTIME_LOG_MAX_BYTES = '1';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const batchDir = path.join(cwd, 'logs', 'realtime', 'batch-batch_1');
      fs.mkdirSync(batchDir, { recursive: true });
      const active = path.join(batchDir, 'realtime.log');
      fs.writeFileSync(active, 'x'.repeat(50), 'utf-8');

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.info('realtime.rotate', { ok: true });
      await logger.close();

      const files = fs.readdirSync(batchDir);
      expect(files).toContain('realtime.log');
      const rotated = files.filter(f => f.startsWith('realtime-') && f.endsWith('.log'));
      expect(rotated.length).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(batchDir, rotated[0] as string), 'utf-8')).toContain('x');
      expect(fs.readFileSync(active, 'utf-8')).toContain('realtime.rotate');
    });
  });

  test('RealtimeLogger writes without correlationId or data fields when omitted', async () => {
    await withTempCwd('realtime-logger-no-corr', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO);
      logger.info('realtime.no_corr');
      await logger.close();

      const dir = path.join(cwd, 'logs', 'realtime');
      const files = fs.readdirSync(dir);
      const file = files.find(f => /^realtime-.*\.log$/.test(f));
      expect(file).toBeTruthy();

      const lines = fs.readFileSync(path.join(dir, file as string), 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1] as string);
      expect(last.message).toBe('realtime.no_corr');
      expect(last.correlationId).toBeUndefined();
      expect(last.data).toBeUndefined();
    });
  });

  test('RealtimeLogger uses batch file when LLM_ADAPTER_BATCH_ID is set and batch dir is disabled', async () => {
    await withTempCwd('realtime-logger-batch-file', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_1';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.debug('realtime.debug', { dataBase64: 'AA==' });
      logger.warning('realtime.warn');
      logger.error('realtime.err');
      logger.info('realtime.test', { systemPrompt: 'TOP_SECRET' });

      // Second call exercises initialization fast-path + retention fast-path.
      logger.info('realtime.test.2', { systemPrompt: 'TOP_SECRET_2' });
      await logger.close();

      const expected = path.join(cwd, 'logs', 'realtime', 'realtime-batch-batch_1.log');
      expect(fs.existsSync(expected)).toBe(true);
      expect(fs.readFileSync(expected, 'utf-8')).toContain('realtime.test');
      expect(fs.readFileSync(expected, 'utf-8')).toContain('[REDACTED_BASE64]');
    });
  });

  test('RealtimeLogger does not create file logs when LLM_ADAPTER_DISABLE_FILE_LOGS=1', async () => {
    await withTempCwd('realtime-logger-disabled', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      const { module } = await setupLoggingTestHarness({ disableFileLogs: true });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.info('realtime.test', { systemPrompt: 'TOP_SECRET' });
      await logger.close();

      expect(fs.existsSync(path.join(cwd, 'logs', 'realtime'))).toBe(false);
    });
  });

  test('RealtimeLogger evaluates retention matchers for non-batch log directories', async () => {
    await withTempCwd('realtime-logger-retention-matchers', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const dir = path.join(cwd, 'logs', 'realtime');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'realtime-old.log'), 'x', 'utf-8');
      fs.writeFileSync(path.join(dir, 'other.log'), 'y', 'utf-8');
      fs.mkdirSync(path.join(dir, 'realtime-dir'), { recursive: true });

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.info('realtime.retention', { ok: true });
      await logger.close();

      const files = fs.readdirSync(dir);
      const created = files.find(f => /^realtime-.*\.log$/.test(f));
      expect(created).toBeTruthy();
      expect(fs.readFileSync(path.join(dir, created as string), 'utf-8')).toContain('realtime.retention');
    });
  });

  test('RealtimeLogger rotates batch-file logs using baseName when batch dir is disabled', async () => {
    await withTempCwd('realtime-logger-rotate-batch-file', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_1';
      process.env.LLM_ADAPTER_REALTIME_LOG_MAX_BYTES = '1';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const dir = path.join(cwd, 'logs', 'realtime');
      fs.mkdirSync(dir, { recursive: true });

      const active = path.join(dir, 'realtime-batch-batch_1.log');
      fs.writeFileSync(active, 'x'.repeat(50), 'utf-8');

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.info('realtime.rotate.batch_file', { ok: true });
      await logger.close();

      const files = fs.readdirSync(dir);
      expect(files).toContain('realtime-batch-batch_1.log');
      const rotated = files.filter(f => f.startsWith('realtime-batch-batch_1-') && f.endsWith('.log'));
      expect(rotated.length).toBeGreaterThan(0);
    });
  });

  test('RealtimeLogger byte tracking and flush scheduler are safe under edge conditions', async () => {
    await withTempCwd('realtime-logger-internal-guards', async () => {
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');

      // Cover scheduleFlush re-entrancy paths without relying on timers.
      (logger as any).flushPromise = Promise.resolve();
      (logger as any).scheduleFlush();
      expect((logger as any).flushAgain).toBe(true);

      (logger as any).flushPromise = null;
      (logger as any).flushScheduled = true;
      expect((logger as any).flushScheduled).toBe(true);
      (logger as any).scheduleFlush();

      (logger as any).flushPromise = null;
      (logger as any).flushScheduled = false;
      expect((logger as any).flushScheduled).toBe(false);
      (logger as any).scheduleFlush();
      await new Promise<void>(resolve => setImmediate(resolve));

      // startFlush: flushAgain loop when there is nothing to write
      (logger as any).flushPromise = null;
      (logger as any).flushAgain = true;
      (logger as any).pendingWrites = [];
      await (logger as any).startFlush();

      // startFlush: pending write but missing logFile -> continue
      (logger as any).flushPromise = null;
      (logger as any).pendingWrites = ['x'];
      (logger as any).logFile = undefined;
      await (logger as any).startFlush();

      // maybeRotateForMaxBytes: early return when logFile is missing
      (logger as any).batchId = 'batch_1';
      (logger as any).logFile = undefined;
      (logger as any).getMaxBytes = () => 1;
      await expect((logger as any).maybeRotateForMaxBytes(1)).resolves.toBeUndefined();

      // startFlush: catch/finally paths
      (logger as any).flushPromise = null;
      (logger as any).pendingWrites = { splice: () => { throw new Error('boom'); } };
      await expect((logger as any).startFlush()).resolves.toBeUndefined();
      (logger as any).pendingWrites = [];

      await logger.close();
    });
  });

  test('RealtimeLogger guards against unexpected stat output and disabled file logging', async () => {
    await withTempCwd('realtime-logger-current-bytes-guards', async () => {
      const statSpy = jest.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 'nope' } as any);

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.info('realtime.current_bytes');

      await expect((logger as any).ensureCurrentBytes()).resolves.toBe(0);
      await expect((logger as any).ensureCurrentBytes()).resolves.toBe(0);

      statSpy.mockRestore();
      await logger.close();
    });

    const { module } = await setupLoggingTestHarness({ disableFileLogs: true });
    const { RealtimeLogger, LogLevel } = module as any;

    const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
    await expect((logger as any).ensureCurrentBytes()).resolves.toBe(0);
    await expect((logger as any).rotateCurrentLogFile()).resolves.toBeUndefined();
    await expect((logger as any).maybeRotateForMaxBytes(1)).resolves.toBeUndefined();
  });

  test('RealtimeLogger max-bytes rotation guard exits early when not in batch mode', async () => {
    await withTempCwd('realtime-logger-rotate-guard-no-batch', async () => {
      process.env.LLM_ADAPTER_REALTIME_LOG_MAX_BYTES = '1000';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.info('realtime.rotate.guard', { ok: true });
      await expect((logger as any).maybeRotateForMaxBytes(1)).resolves.toBeUndefined();
      await logger.close();
    });
  });

  test('RealtimeLogger max-bytes rotation guard is a no-op when below threshold', async () => {
    await withTempCwd('realtime-logger-rotate-guard-below-threshold', async () => {
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_1';
      process.env.LLM_ADAPTER_REALTIME_LOG_MAX_BYTES = '1000';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.info('realtime.rotate.guard', { ok: true });
      await expect((logger as any).maybeRotateForMaxBytes(1)).resolves.toBeUndefined();
      await logger.close();
    });
  });
});
