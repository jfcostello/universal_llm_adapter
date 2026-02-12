import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('core/logging pretty-file-logs helper', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('resolvePrettyFileLogsMode falls back when env value is invalid', async () => {
    await withTempCwd('pretty-file-logs-env-invalid', async () => {
      process.env.LLM_ADAPTER_LOG_PRETTY_FILE_MODE = 'not-a-mode';

      const { resolvePrettyFileLogsMode } = await import('@/modules/logging/internal/pretty-file-logs.ts');

      expect(resolvePrettyFileLogsMode()).toBe('async');
    });
  });

  test('createPrettyFileAppender in off mode is a no-op', async () => {
    await withTempCwd('pretty-file-logs-off', async (cwd) => {
      const { createPrettyFileAppender } = await import('@/modules/logging/internal/pretty-file-logs.ts');

      const filePath = path.join(cwd, 'logs', 'llm', 'noop.log');
      const appender = createPrettyFileAppender({ filePath, mode: 'off' });

      appender.append('hello');
      await appender.flush();

      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  test('createPrettyFileAppender async mode bounds memory by evicting oldest buffered writes', async () => {
    await withTempCwd('pretty-file-logs-async-bounded', async (cwd) => {
      const { createPrettyFileAppender, PRETTY_FILE_LOGS_ASYNC_MAX_PENDING_BYTES } = await import(
        '@/modules/logging/internal/pretty-file-logs.ts'
      );

      const filePath = path.join(cwd, 'logs', 'llm', 'bounded.log');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const appender = createPrettyFileAppender({ filePath, mode: 'async' });

      const entrySize = Math.floor(PRETTY_FILE_LOGS_ASYNC_MAX_PENDING_BYTES / 2.5);
      const firstTag = 'FIRST_ENTRY';
      const secondTag = 'SECOND_ENTRY';
      const thirdTag = 'THIRD_ENTRY';

      appender.append(`${firstTag}:${'A'.repeat(entrySize)}`);
      appender.append(`${secondTag}:${'B'.repeat(entrySize)}`);
      appender.append(`${thirdTag}:${'C'.repeat(entrySize)}`);
      await appender.flush();

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toContain(firstTag);
      expect(content).toContain(secondTag);
      expect(content).toContain(thirdTag);
    });
  });

  test('createPrettyFileAppender async mode drops single entries larger than max buffer', async () => {
    await withTempCwd('pretty-file-logs-async-oversized-entry', async (cwd) => {
      const { createPrettyFileAppender, PRETTY_FILE_LOGS_ASYNC_MAX_PENDING_BYTES } = await import(
        '@/modules/logging/internal/pretty-file-logs.ts'
      );

      const filePath = path.join(cwd, 'logs', 'llm', 'oversized.log');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const appender = createPrettyFileAppender({ filePath, mode: 'async' });

      appender.append('X'.repeat(PRETTY_FILE_LOGS_ASYNC_MAX_PENDING_BYTES + 1));
      await appender.flush();

      expect(fs.existsSync(filePath)).toBe(false);
    });
  });
});
