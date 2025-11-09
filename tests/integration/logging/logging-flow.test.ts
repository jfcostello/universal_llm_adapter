import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

async function loadLoggingModule() {
  jest.resetModules();
  return await import('@/core/logging.ts');
}

describe('integration/logging/logging-flow', () => {
  test('AdapterLogger redacts sensitive headers before logging', async () => {
    const { AdapterLogger, LogLevel } = await loadLoggingModule();
    const logger = new AdapterLogger(LogLevel.INFO);
    const redacted = (logger as any).redactHeaders({
      Authorization: 'Bearer sk-secret-key'
    });

    expect(redacted.Authorization).toBe('Bearer ***-key');
  });

  test('correlation child logger preserves metadata in structured output', async () => {
    const { AdapterLogger, LogLevel } = await loadLoggingModule();
    const logger = new AdapterLogger(LogLevel.INFO);
    const correlated = logger.withCorrelation('corr-123');
    const infoSpy = jest.spyOn((correlated as any).logger, 'info');

    try {
      correlated.info('testing', { extra: true });
      expect(infoSpy).toHaveBeenCalledWith('testing', { extra: true });
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('writes adapter logs to batch-specific file when batch id set', async () => {
    await withTempCwd('logging-batch-file', async cwd => {
      const originalFile = process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
      const originalConsole = process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
      const originalBatch = process.env.LLM_ADAPTER_BATCH_ID;

      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';
      process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '1';
      process.env.LLM_ADAPTER_BATCH_ID = 'batch_case';

      try {
        const { AdapterLogger, LogLevel } = await loadLoggingModule();
        const logger = new AdapterLogger(LogLevel.INFO);
        logger.info('batch-log-message');
        await logger.close();

        const logPath = path.join(cwd, 'logs', 'adapter-batch-batch_case.log');
        expect(fs.existsSync(logPath)).toBe(true);
        const content = fs.readFileSync(logPath, 'utf8');
        expect(content).toContain('batch-log-message');
      } finally {
        if (originalFile === undefined) {
          delete process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
        } else {
          process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = originalFile;
        }
        if (originalConsole === undefined) {
          delete process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
        } else {
          process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = originalConsole;
        }
        if (originalBatch === undefined) {
          delete process.env.LLM_ADAPTER_BATCH_ID;
        } else {
          process.env.LLM_ADAPTER_BATCH_ID = originalBatch;
        }
      }
    });
  });

  test('writes llm logs inside batch directory when batch dir flag enabled', async () => {
    await withTempCwd('logging-batch-dir', async cwd => {
      const originalFile = process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
      const originalConsole = process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
      const originalBatch = process.env.LLM_ADAPTER_BATCH_ID;
      const originalDir = process.env.LLM_ADAPTER_BATCH_DIR;

      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';
      process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '1';
      process.env.LLM_ADAPTER_BATCH_ID = 'session42';
      process.env.LLM_ADAPTER_BATCH_DIR = '1';

      try {
        const { AdapterLogger, LogLevel } = await loadLoggingModule();
        const logger = new AdapterLogger(LogLevel.INFO);
        logger.logLLMRequest({
          url: 'https://example.com',
          method: 'POST',
          headers: {},
          body: {}
        });
        await logger.close();

        const llmDir = path.join(cwd, 'logs', 'llm', 'batch-session42');
        expect(fs.existsSync(llmDir)).toBe(true);
        const files = fs.readdirSync(llmDir);
        expect(files).toContain('llm.log');
      } finally {
        if (originalFile === undefined) {
          delete process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
        } else {
          process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = originalFile;
        }
        if (originalConsole === undefined) {
          delete process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
        } else {
          process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = originalConsole;
        }
        if (originalBatch === undefined) {
          delete process.env.LLM_ADAPTER_BATCH_ID;
        } else {
          process.env.LLM_ADAPTER_BATCH_ID = originalBatch;
        }
        if (originalDir === undefined) {
          delete process.env.LLM_ADAPTER_BATCH_DIR;
        } else {
          process.env.LLM_ADAPTER_BATCH_DIR = originalDir;
        }
      }
    });
  });

  test('respects log level filtering on console output', async () => {
    const originalFile = process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
    const originalConsole = process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
    process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
    process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '0';

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true as any);
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true as any);

    try {
      const { AdapterLogger, LogLevel } = await loadLoggingModule();
      const logger = new AdapterLogger(LogLevel.ERROR);

      logger.info('ignored');
      await new Promise(resolve => setImmediate(resolve));
      expect(stdoutSpy).not.toHaveBeenCalled();

      logger.error('boom');
      await new Promise(resolve => setImmediate(resolve));
      expect(stderrSpy).toHaveBeenCalled();

      await logger.close();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      if (originalFile === undefined) {
        delete process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
      } else {
        process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = originalFile;
      }
      if (originalConsole === undefined) {
        delete process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
      } else {
        process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = originalConsole;
      }
    }
  });

  test('emits structured JSON log records', async () => {
    const originalFile = process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
    const originalConsole = process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
    process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
    process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '0';

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true as any);

    try {
      const { AdapterLogger, LogLevel } = await loadLoggingModule();
      const logger = new AdapterLogger(LogLevel.INFO, 'corr-structured');
      logger.info('structured-message', { extra: true });
      await new Promise(resolve => setImmediate(resolve));

      expect(stdoutSpy).toHaveBeenCalled();
      const payload = JSON.parse(stdoutSpy.mock.calls[0][0]);
      expect(payload).toMatchObject({
        type: 'log',
        level: 'info',
        message: 'structured-message',
        correlationId: 'corr-structured',
        data: { extra: true }
      });

      await logger.close();
    } finally {
      stdoutSpy.mockRestore();
      if (originalFile === undefined) {
        delete process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
      } else {
        process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = originalFile;
      }
      if (originalConsole === undefined) {
        delete process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
      } else {
        process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = originalConsole;
      }
    }
  });

  test('default file transport rotates using date-based filenames', async () => {
    await withTempCwd('logging-rotation', async cwd => {
      const originalFile = process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
      const originalConsole = process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
      const originalBatch = process.env.LLM_ADAPTER_BATCH_ID;
      const originalDir = process.env.LLM_ADAPTER_BATCH_DIR;

      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';
      process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '1';
      if (originalBatch !== undefined) delete process.env.LLM_ADAPTER_BATCH_ID;
      if (originalDir !== undefined) delete process.env.LLM_ADAPTER_BATCH_DIR;

      try {
        const { AdapterLogger, LogLevel } = await loadLoggingModule();
        const logger = new AdapterLogger(LogLevel.INFO);
        logger.info('rotation-entry');
        await logger.close();

        const files = fs.readdirSync(path.join(cwd, 'logs'));
        const rotationFile = files.find(file => file.startsWith('adapter-'));
        expect(rotationFile).toBeDefined();
        const content = fs.readFileSync(path.join(cwd, 'logs', rotationFile!), 'utf8');
        expect(content).toContain('rotation-entry');
      } finally {
        if (originalFile === undefined) {
          delete process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
        } else {
          process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = originalFile;
        }
        if (originalConsole === undefined) {
          delete process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
        } else {
          process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = originalConsole;
        }
        if (originalBatch !== undefined) {
          process.env.LLM_ADAPTER_BATCH_ID = originalBatch;
        }
        if (originalDir !== undefined) {
          process.env.LLM_ADAPTER_BATCH_DIR = originalDir;
        }
      }
    });
  });

  test('sanitizes error payloads before logging', async () => {
    const originalFile = process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
    const originalConsole = process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
    process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
    process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = '0';

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true as any);

    try {
      const { AdapterLogger, LogLevel } = await loadLoggingModule();
      const logger = new AdapterLogger(LogLevel.ERROR);
      const error = new Error('boom');
      logger.error('failure', error);
      await new Promise(resolve => setImmediate(resolve));

      const payload = JSON.parse(stderrSpy.mock.calls[0][0]);
      expect(payload.level).toBe('error');
      expect(payload.data?.error?.message).toBe('boom');
      const stack = payload.data?.error?.stack;
      if (stack) {
        expect(stack.split('\n').length).toBeLessThanOrEqual(5);
      }

      await logger.close();
    } finally {
      stderrSpy.mockRestore();
      if (originalFile === undefined) {
        delete process.env.LLM_ADAPTER_DISABLE_FILE_LOGS;
      } else {
        process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = originalFile;
      }
      if (originalConsole === undefined) {
        delete process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;
      } else {
        process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS = originalConsole;
      }
    }
  });
});
