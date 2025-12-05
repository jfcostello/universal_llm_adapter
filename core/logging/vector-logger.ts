import fs from 'fs';
import path from 'path';
import {
  BaseAdapterLogger,
  LogLevel,
  createIsoFilenameStamp,
  createIsoTimestamp,
  disableFileLogs,
  vectorLogDir,
  getBatchEnv,
  VECTOR_MAX_FILES,
  VECTOR_MAX_AGE_DAYS
} from './base-logger.js';
import { enforceRetention } from '../../utils/logging/retention.js';

export class VectorLogger extends BaseAdapterLogger {
  private vectorLogFile?: string;
  private vectorRetentionApplied = false;
  private initialized = false;

  constructor(level: LogLevel = LogLevel.INFO, correlationId?: string) {
    super(level, correlationId);
  }

  logVectorRequest(data: {
    operation: string;
    store: string;
    collection?: string;
    params: Record<string, any>;
  }): void {
    this.ensureInitialized();
    if (!this.vectorLogFile || disableFileLogs) return;

    const separator = '\n' + '='.repeat(80) + '\n';
    const log = [
      separator,
      `>>> VECTOR OPERATION: ${data.operation} >>>`,
      separator,
      `Timestamp: ${createIsoTimestamp()}`,
      `Store: ${data.store}`,
      data.collection ? `Collection: ${data.collection}` : null,
      '',
      '--- PARAMS ---',
      JSON.stringify(data.params, null, 2),
      separator,
      ''
    ].filter(Boolean).join('\n');

    fs.appendFileSync(this.vectorLogFile, log);
    this.applyVectorRetentionOnce();
  }

  logVectorResponse(data: {
    operation: string;
    store: string;
    collection?: string;
    result: any;
    duration?: number;
  }): void {
    this.ensureInitialized();
    if (!this.vectorLogFile || disableFileLogs) return;

    const separator = '\n' + '='.repeat(80) + '\n';
    const log = [
      separator,
      `<<< VECTOR RESULT: ${data.operation} <<<`,
      separator,
      `Timestamp: ${createIsoTimestamp()}`,
      `Store: ${data.store}`,
      data.collection ? `Collection: ${data.collection}` : null,
      data.duration !== undefined ? `Duration: ${data.duration}ms` : null,
      '',
      '--- RESULT ---',
      JSON.stringify(data.result, null, 2),
      separator,
      ''
    ].filter(Boolean).join('\n');

    fs.appendFileSync(this.vectorLogFile, log);
    this.applyVectorRetentionOnce();
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    if (disableFileLogs) {
      this.initialized = true;
      return;
    }

    const { batchId, useBatchDir } = getBatchEnv();
    this.ensureDir(vectorLogDir);

    if (batchId) {
      const baseDir = useBatchDir ? path.join(vectorLogDir, `batch-${batchId}`) : vectorLogDir;
      this.ensureDir(baseDir);
      this.vectorLogFile = useBatchDir
        ? path.join(baseDir, 'vector.log')
        : path.join(baseDir, `vector-batch-${batchId}.log`);
    } else {
      const timestamp = createIsoFilenameStamp();
      this.vectorLogFile = path.join(vectorLogDir, `vector-${timestamp}.log`);
    }

    this.initialized = true;
  }

  private applyVectorRetentionOnce(): void {
    if (this.vectorRetentionApplied || disableFileLogs) return;
    const { batchId, useBatchDir } = getBatchEnv();

    /* istanbul ignore else */
    if (batchId && useBatchDir) {
      enforceRetention(vectorLogDir, {
        includeDirs: true,
        match: (d) => d.isDirectory() && d.name.startsWith('batch-'),
        maxFiles: VECTOR_MAX_FILES,
        maxAgeDays: VECTOR_MAX_AGE_DAYS,
        // Exclude current batch dir when present; safe to ignore when missing during tests
        /* istanbul ignore next */
        exclude: this.vectorLogFile ? [path.dirname(this.vectorLogFile)] : undefined
      });
    } else {
      enforceRetention(vectorLogDir, {
        includeDirs: false,
        match: (d) => d.isFile() && /^vector.*\.log$/.test(d.name),
        maxFiles: VECTOR_MAX_FILES,
        maxAgeDays: VECTOR_MAX_AGE_DAYS,
        // Exclude current log file if present to avoid pruning the active file
        /* istanbul ignore next */
        exclude: this.vectorLogFile ? [this.vectorLogFile] : undefined
      });
    }

    this.vectorRetentionApplied = true;
  }
}
