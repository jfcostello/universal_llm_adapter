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

      expect(resolvePrettyFileLogsMode()).toBe('sync');
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
});

