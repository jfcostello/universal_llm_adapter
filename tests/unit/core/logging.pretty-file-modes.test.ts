import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { withTempCwd } from '@tests/helpers/temp-files.ts';
import { setupLoggingTestHarness } from '@tests/helpers/logger.ts';

describe('core/logging pretty file log modes', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('async mode buffers and only writes on closeLogger()', async () => {
    await withTempCwd('logging-pretty-async', async (cwd) => {
      process.env.LLM_ADAPTER_LOG_PRETTY_FILE_MODE = 'async';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { getLLMLogger, closeLogger } = module as any;

      const logger = getLLMLogger();
      logger.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { ok: true } });

      const llmDir = path.join(cwd, 'logs', 'llm');
      const filesBefore = fs.existsSync(llmDir) ? fs.readdirSync(llmDir) : [];
      if (filesBefore.length > 0) {
        const contentBefore = fs.readFileSync(path.join(llmDir, filesBefore[0] as string), 'utf-8');
        expect(contentBefore).not.toContain('>>> OUTGOING REQUEST >>>');
      }

      await closeLogger();

      expect(fs.existsSync(llmDir)).toBe(true);
      const filesAfter = fs.readdirSync(llmDir);
      expect(filesAfter.length).toBeGreaterThan(0);
      const contentAfter = fs.readFileSync(path.join(llmDir, filesAfter[0] as string), 'utf-8');
      expect(contentAfter).toContain('>>> OUTGOING REQUEST >>>');
    });
  });

  test('async mode flushes embedding and vector pretty logs on closeLogger()', async () => {
    await withTempCwd('logging-pretty-async-embedding-vector', async (cwd) => {
      process.env.LLM_ADAPTER_LOG_PRETTY_FILE_MODE = 'async';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { getEmbeddingLogger, getVectorLogger, closeLogger } = module as any;

      const embeddingLogger = getEmbeddingLogger();
      embeddingLogger.logEmbeddingRequest({ url: 'http://x', method: 'POST', headers: {}, body: { ok: true } });

      const vectorLogger = getVectorLogger();
      vectorLogger.logVectorRequest({ operation: 'query', store: 's', params: { topK: 1 } });

      await closeLogger();

      const embeddingDir = path.join(cwd, 'logs', 'embedding');
      expect(fs.existsSync(embeddingDir)).toBe(true);
      const embeddingFiles = fs.readdirSync(embeddingDir);
      expect(embeddingFiles.length).toBeGreaterThan(0);
      const embeddingContent = fs.readFileSync(path.join(embeddingDir, embeddingFiles[0] as string), 'utf-8');
      expect(embeddingContent).toContain('>>> EMBEDDING REQUEST >>>');

      const vectorDir = path.join(cwd, 'logs', 'vector');
      expect(fs.existsSync(vectorDir)).toBe(true);
      const vectorFiles = fs.readdirSync(vectorDir);
      expect(vectorFiles.length).toBeGreaterThan(0);
      const vectorContent = fs.readFileSync(path.join(vectorDir, vectorFiles[0] as string), 'utf-8');
      expect(vectorContent).toContain('>>> VECTOR OPERATION: query >>>');
    });
  });

  test('off mode does not create LLM pretty log directories', async () => {
    await withTempCwd('logging-pretty-off', async (cwd) => {
      process.env.LLM_ADAPTER_LOG_PRETTY_FILE_MODE = 'off';
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const { module } = await setupLoggingTestHarness({ disableFileLogs: false });
      const { getLLMLogger } = module as any;

      const logger = getLLMLogger();
      logger.logLLMRequest({ url: 'http://x', method: 'POST', headers: {}, body: { ok: true } });

      expect(fs.existsSync(path.join(cwd, 'logs', 'llm'))).toBe(false);
    });
  });
});
