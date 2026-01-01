import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { withTempCwd } from '@tests/helpers/temp-files.ts';
import { setupLoggingTestHarness } from '@tests/helpers/logger.ts';

describe('core/logging voice + realtime file logs', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('VoiceLogger writes redacted JSON lines to logs/voice', async () => {
    await withTempCwd('voice-logger-file', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VoiceLogger, LogLevel } = module as any;

      const logger = new VoiceLogger(LogLevel.INFO, 'corr-voice');
      logger.info('voice.test', { systemPrompt: 'TOP_SECRET', dataBase64: 'AA==' });

      const dir = path.join(cwd, 'logs', 'voice');
      const files = fs.readdirSync(dir);
      const file = files.find(f => /^voice-.*\.log$/.test(f));
      expect(file).toBeTruthy();

      const content = fs.readFileSync(path.join(dir, file as string), 'utf-8');
      expect(content).toContain('voice.test');
      expect(content).toContain('TOP_SECRET');
      expect(content).toContain('[REDACTED_BASE64]');
      expect(content).not.toContain('AA==');
    });
  });

  test('VoiceLogger uses batch dir when LLM_ADAPTER_BATCH_DIR=1', async () => {
    await withTempCwd('voice-logger-batch-dir', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_1';
      process.env.LLM_ADAPTER_BATCH_DIR = '1';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VoiceLogger, LogLevel } = module as any;

      const logger = new VoiceLogger(LogLevel.INFO, 'corr-voice');
      logger.info('voice.test', { systemPrompt: 'TOP_SECRET' });

      const expected = path.join(cwd, 'logs', 'voice', 'batch-batch_1', 'voice.log');
      expect(fs.existsSync(expected)).toBe(true);
      expect(fs.readFileSync(expected, 'utf-8')).toContain('voice.test');
    });
  });

  test('VoiceLogger writes without correlationId or data fields when omitted', async () => {
    await withTempCwd('voice-logger-no-corr', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VoiceLogger, LogLevel } = module as any;

      const logger = new VoiceLogger(LogLevel.INFO);
      logger.info('voice.no_corr');

      const dir = path.join(cwd, 'logs', 'voice');
      const files = fs.readdirSync(dir);
      const file = files.find(f => /^voice-.*\.log$/.test(f));
      expect(file).toBeTruthy();

      const lines = fs.readFileSync(path.join(dir, file as string), 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1] as string);
      expect(last.message).toBe('voice.no_corr');
      expect(last.correlationId).toBeUndefined();
      expect(last.data).toBeUndefined();
    });
  });

  test('VoiceLogger uses batch file when LLM_ADAPTER_BATCH_ID is set and batch dir is disabled', async () => {
    await withTempCwd('voice-logger-batch-file', async (cwd) => {
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_1';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { VoiceLogger, LogLevel } = module as any;

      const logger = new VoiceLogger(LogLevel.INFO, 'corr-voice');
      logger.debug('voice.debug', { dataBase64: 'AA==' });
      logger.warning('voice.warn');
      logger.error('voice.err');
      logger.info('voice.test', { systemPrompt: 'TOP_SECRET' });

      // Second call exercises initialization fast-path + retention fast-path.
      logger.info('voice.test.2', { systemPrompt: 'TOP_SECRET_2' });

      const expected = path.join(cwd, 'logs', 'voice', 'voice-batch-batch_1.log');
      expect(fs.existsSync(expected)).toBe(true);
      expect(fs.readFileSync(expected, 'utf-8')).toContain('voice.test');
      expect(fs.readFileSync(expected, 'utf-8')).toContain('[REDACTED_BASE64]');
    });
  });

  test('VoiceLogger does not create file logs when LLM_ADAPTER_DISABLE_FILE_LOGS=1', async () => {
    await withTempCwd('voice-logger-disabled', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      const { module } = await setupLoggingTestHarness({ disableFileLogs: true });
      const { VoiceLogger, LogLevel } = module as any;

      const logger = new VoiceLogger(LogLevel.INFO, 'corr-voice');
      logger.info('voice.test', { systemPrompt: 'TOP_SECRET' });

      expect(fs.existsSync(path.join(cwd, 'logs', 'voice'))).toBe(false);
    });
  });

  test('RealtimeLogger writes redacted JSON lines to logs/realtime', async () => {
    await withTempCwd('realtime-logger-file', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));
      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { RealtimeLogger, LogLevel } = module as any;

      const logger = new RealtimeLogger(LogLevel.INFO, 'corr-rt');
      logger.info('realtime.test', { systemPrompt: 'TOP_SECRET', dataBase64: 'AA==' });

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

      const expected = path.join(cwd, 'logs', 'realtime', 'batch-batch_1', 'realtime.log');
      expect(fs.existsSync(expected)).toBe(true);
      expect(fs.readFileSync(expected, 'utf-8')).toContain('realtime.test');
    });
  });
});
