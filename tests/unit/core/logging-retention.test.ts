import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

async function loadLoggingModule() {
  jest.resetModules();
  return await import('@/core/logging.ts');
}

describe('core/logging retention', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
  });

  test('LLM timestamped logs are capped by LLM_ADAPTER_LLM_LOG_MAX_FILES', async () => {
    await withTempCwd('llm-retention-files', async (cwd) => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';
      process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '1';
      process.env.LLM_ADAPTER_LLM_LOG_MAX_FILES = '2';

      const { AdapterLogger, LogLevel } = await loadLoggingModule();

      jest.useFakeTimers();
      const t1 = new Date('2025-10-18T10:00:00.000Z');
      const t2 = new Date('2025-10-18T10:00:01.000Z');
      const t3 = new Date('2025-10-18T10:00:02.000Z');

      jest.setSystemTime(t1);
      const l1 = new AdapterLogger(LogLevel.INFO);
      l1.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { n: 1 } });

      jest.setSystemTime(t2);
      const l2 = new AdapterLogger(LogLevel.INFO);
      l2.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { n: 2 } });

      jest.setSystemTime(t3);
      const l3 = new AdapterLogger(LogLevel.INFO);
      l3.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { n: 3 } });

      await l1.close();
      await l2.close();
      await l3.close();

      const llmDir = path.join(cwd, 'logs', 'llm');
      const files = fs.readdirSync(llmDir).filter(f => f.startsWith('llm-'));
      expect(files.length).toBe(2);
      // Newest two should remain (t2 and t3)
      expect(files).toContain('llm-2025-10-18T10-00-01-000Z.log');
      expect(files).toContain('llm-2025-10-18T10-00-02-000Z.log');
    });
  });

  test('LLM batch directories are capped when LLM_ADAPTER_BATCH_DIR=1', async () => {
    await withTempCwd('llm-retention-batch', async (cwd) => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';
      process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '1';
      process.env.LLM_ADAPTER_LLM_LOG_MAX_FILES = '2';
      process.env.LLM_ADAPTER_BATCH_DIR = '1';

      const { AdapterLogger, LogLevel } = await loadLoggingModule();

      process.env.LLM_ADAPTER_BATCH_ID = 'b1';
      const l1 = new AdapterLogger(LogLevel.INFO);
      l1.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { n: 1 } });

      process.env.LLM_ADAPTER_BATCH_ID = 'b2';
      const l2 = new AdapterLogger(LogLevel.INFO);
      l2.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { n: 2 } });

      process.env.LLM_ADAPTER_BATCH_ID = 'b3';
      const l3 = new AdapterLogger(LogLevel.INFO);
      l3.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { n: 3 } });

      await l1.close();
      await l2.close();
      await l3.close();

      const llmRoot = path.join(cwd, 'logs', 'llm');
      const dirs = fs.readdirSync(llmRoot).filter(n => n.startsWith('batch-'));
      expect(dirs.sort()).toEqual(['batch-b2', 'batch-b3']);
      // Ensure llm.log exists in remaining batches
      for (const d of dirs) {
        expect(fs.existsSync(path.join(llmRoot, d, 'llm.log'))).toBe(true);
      }
    });
  });

  test('adapter batch base files are capped by LLM_ADAPTER_BATCH_LOG_MAX_FILES', async () => {
    await withTempCwd('adapter-batch-retention', async (cwd) => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';
      process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '1';
      process.env.LLM_ADAPTER_BATCH_LOG_MAX_FILES = '2';

      const { AdapterLogger, LogLevel } = await loadLoggingModule();

      process.env.LLM_ADAPTER_BATCH_ID = 'x1';
      const a1 = new AdapterLogger(LogLevel.INFO);
      a1.info('one');
      await a1.close();

      process.env.LLM_ADAPTER_BATCH_ID = 'x2';
      const a2 = new AdapterLogger(LogLevel.INFO);
      a2.info('two');
      await a2.close();

      process.env.LLM_ADAPTER_BATCH_ID = 'x3';
      const a3 = new AdapterLogger(LogLevel.INFO);
      a3.info('three');
      await a3.close();

      const files = fs.readdirSync(path.join(cwd, 'logs')).filter(f => f.startsWith('adapter-batch-'));
      // Only last 2 batch base files should remain
      expect(files.sort()).toEqual(['adapter-batch-x2.log', 'adapter-batch-x3.log']);
    });
  });

  test('LLM batch-named files are capped when LLM_ADAPTER_BATCH_ID is set without batch dir', async () => {
    await withTempCwd('llm-retention-batch-files', async (cwd) => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';
      process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '1';
      process.env.LLM_ADAPTER_LLM_LOG_MAX_FILES = '2';

      const { AdapterLogger, LogLevel } = await loadLoggingModule();

      process.env.LLM_ADAPTER_BATCH_ID = 'f1';
      const l1 = new AdapterLogger(LogLevel.INFO);
      l1.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { n: 1 } });
      await l1.close();

      process.env.LLM_ADAPTER_BATCH_ID = 'f2';
      const l2 = new AdapterLogger(LogLevel.INFO);
      l2.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { n: 2 } });
      await l2.close();

      process.env.LLM_ADAPTER_BATCH_ID = 'f3';
      const l3 = new AdapterLogger(LogLevel.INFO);
      l3.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { n: 3 } });
      await l3.close();

      const llmDir = path.join(cwd, 'logs', 'llm');
      const files = fs.readdirSync(llmDir).filter(f => f.startsWith('llm-batch-'));
      expect(files.sort()).toEqual(['llm-batch-f2.log', 'llm-batch-f3.log']);
    });
  });
});
