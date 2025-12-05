import fs from 'fs';
import path from 'path';
import {
  BaseAdapterLogger,
  LogLevel,
  createIsoFilenameStamp,
  createIsoTimestamp,
  disableFileLogs,
  embeddingLogDir,
  getBatchEnv,
  EMBEDDING_MAX_FILES,
  EMBEDDING_MAX_AGE_DAYS
} from './base-logger.js';
import { enforceRetention } from '../../utils/logging/retention.js';

export class EmbeddingLogger extends BaseAdapterLogger {
  private embeddingLogFile?: string;
  private embeddingRetentionApplied = false;
  private initialized = false;

  constructor(level: LogLevel = LogLevel.INFO, correlationId?: string) {
    super(level, correlationId);
  }

  logEmbeddingRequest(data: {
    url: string;
    method: string;
    headers: Record<string, any>;
    body: any;
    provider?: string;
    model?: string;
  }): void {
    this.ensureInitialized();
    if (!this.embeddingLogFile || disableFileLogs) return;

    const separator = '\n' + '='.repeat(80) + '\n';
    const log = [
      separator,
      '>>> EMBEDDING REQUEST >>>',
      separator,
      `Timestamp: ${createIsoTimestamp()}`,
      data.provider ? `Provider: ${data.provider}` : null,
      data.model ? `Model: ${data.model}` : null,
      `Method: ${data.method}`,
      `URL: ${data.url}`,
      '',
      '--- HEADERS ---',
      JSON.stringify(this.redactHeaders(data.headers), null, 2),
      '',
      '--- BODY ---',
      JSON.stringify(data.body, null, 2),
      separator,
      ''
    ].filter(Boolean).join('\n');

    fs.appendFileSync(this.embeddingLogFile, log);
    this.applyEmbeddingRetentionOnce();
  }

  logEmbeddingResponse(data: {
    status: number;
    statusText?: string;
    headers: Record<string, any>;
    body: any;
    dimensions?: number;
    tokenCount?: number;
  }): void {
    this.ensureInitialized();
    if (!this.embeddingLogFile || disableFileLogs) return;

    const separator = '\n' + '='.repeat(80) + '\n';
    const log = [
      separator,
      '<<< EMBEDDING RESPONSE <<<',
      separator,
      `Timestamp: ${createIsoTimestamp()}`,
      `Status: ${data.status} ${data.statusText || ''}`,
      data.dimensions !== undefined ? `Dimensions: ${data.dimensions}` : null,
      data.tokenCount !== undefined ? `Token Count: ${data.tokenCount}` : null,
      '',
      '--- HEADERS ---',
      JSON.stringify(data.headers, null, 2),
      '',
      '--- BODY ---',
      JSON.stringify(data.body, null, 2),
      separator,
      ''
    ].filter(Boolean).join('\n');

    fs.appendFileSync(this.embeddingLogFile, log);
    this.applyEmbeddingRetentionOnce();
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    if (disableFileLogs) {
      this.initialized = true;
      return;
    }

    const { batchId, useBatchDir } = getBatchEnv();
    this.ensureDir(embeddingLogDir);

    if (batchId) {
      const baseDir = useBatchDir ? path.join(embeddingLogDir, `batch-${batchId}`) : embeddingLogDir;
      this.ensureDir(baseDir);
      this.embeddingLogFile = useBatchDir
        ? path.join(baseDir, 'embedding.log')
        : path.join(baseDir, `embedding-batch-${batchId}.log`);
    } else {
      const timestamp = createIsoFilenameStamp();
      this.embeddingLogFile = path.join(embeddingLogDir, `embedding-${timestamp}.log`);
    }

    this.initialized = true;
  }

  private applyEmbeddingRetentionOnce(): void {
    if (this.embeddingRetentionApplied || disableFileLogs) return;
    const { batchId, useBatchDir } = getBatchEnv();

    if (batchId && useBatchDir) {
      const excludePaths: string[] = [];
      if (this.embeddingLogFile) {
        excludePaths.push(path.dirname(this.embeddingLogFile));
      }
      enforceRetention(embeddingLogDir, {
        includeDirs: true,
        match: (d) => d.isDirectory() && d.name.startsWith('batch-'),
        maxFiles: EMBEDDING_MAX_FILES,
        maxAgeDays: EMBEDDING_MAX_AGE_DAYS,
        exclude: excludePaths
      });
    } else {
      const excludePaths: string[] = [];
      if (this.embeddingLogFile) {
        excludePaths.push(this.embeddingLogFile);
      }
      enforceRetention(embeddingLogDir, {
        includeDirs: false,
        match: (d) => d.isFile() && /^embedding.*\.log$/.test(d.name),
        maxFiles: EMBEDDING_MAX_FILES,
        maxAgeDays: EMBEDDING_MAX_AGE_DAYS,
        exclude: excludePaths
      });
    }

    this.embeddingRetentionApplied = true;
  }
}
