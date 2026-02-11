import path from 'path';
import {
  BaseAdapterLogger,
  type AdapterLoggerOptions,
  LogLevel,
  createIsoFilenameStamp,
  createIsoTimestamp,
  disableFileLogs,
  vectorLogDir,
  getBatchEnv,
  VECTOR_MAX_FILES,
  VECTOR_MAX_AGE_DAYS
} from './base-logger.js';
import { applyRetentionOnce } from './retention-manager.js';
import { createPrettyFileAppender, resolvePrettyFileLogsMode, type PrettyFileAppender } from './pretty-file-logs.js';

export class VectorLogger extends BaseAdapterLogger {
  private vectorLogFile?: string;
  private vectorRetentionApplied = false;
  private initialized = false;
  private readonly prettyFileLogsMode = resolvePrettyFileLogsMode();
  private prettyAppender: PrettyFileAppender | null = null;

  constructor(level: LogLevel = LogLevel.INFO, correlationId?: string | string[], options: AdapterLoggerOptions = {}) {
    super(level, correlationId, options);
  }

  logVectorRequest(data: {
    operation: string;
    store: string;
    collection?: string;
    params: Record<string, any>;
  }): void {
    if (disableFileLogs || this.prettyFileLogsMode === 'off') return;
    this.ensureInitialized();
    const logFile = this.vectorLogFile!;

    if (!this.prettyAppender) {
      this.prettyAppender = createPrettyFileAppender({ filePath: logFile, mode: this.prettyFileLogsMode });
    }

    const correlationIdStr = this.formatCorrelationId();
    const separator = '\n' + '='.repeat(80) + '\n';
    const log = [
      separator,
      `>>> VECTOR OPERATION: ${data.operation} >>>`,
      separator,
      `Timestamp: ${createIsoTimestamp()}`,
      correlationIdStr ? `CorrelationId: ${correlationIdStr}` : null,
      `Store: ${data.store}`,
      data.collection ? `Collection: ${data.collection}` : null,
      '',
      '--- PARAMS ---',
      JSON.stringify(data.params, null, 2),
      separator,
      ''
    ].filter(Boolean).join('\n');

    this.prettyAppender.append(log);
    this.applyVectorRetentionOnce();
  }

  logVectorResponse(data: {
    operation: string;
    store: string;
    collection?: string;
    result: any;
    duration?: number;
  }): void {
    if (disableFileLogs || this.prettyFileLogsMode === 'off') return;
    this.ensureInitialized();
    const logFile = this.vectorLogFile!;

    if (!this.prettyAppender) {
      this.prettyAppender = createPrettyFileAppender({ filePath: logFile, mode: this.prettyFileLogsMode });
    }

    const correlationIdStr = this.formatCorrelationId();
    const separator = '\n' + '='.repeat(80) + '\n';
    const log = [
      separator,
      `<<< VECTOR RESULT: ${data.operation} <<<`,
      separator,
      `Timestamp: ${createIsoTimestamp()}`,
      correlationIdStr ? `CorrelationId: ${correlationIdStr}` : null,
      `Store: ${data.store}`,
      data.collection ? `Collection: ${data.collection}` : null,
      data.duration !== undefined ? `Duration: ${data.duration}ms` : null,
      '',
      '--- RESULT ---',
      JSON.stringify(data.result, null, 2),
      separator,
      ''
    ].filter(Boolean).join('\n');

    this.prettyAppender.append(log);
    this.applyVectorRetentionOnce();
  }

  override async close(): Promise<void> {
    if (this.prettyAppender) {
      await this.prettyAppender.flush();
    }
    await super.close();
  }

  private ensureInitialized(): void {
    if (this.initialized) return;

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

    if (batchId && useBatchDir) {
      applyRetentionOnce(vectorLogDir, {
        includeDirs: true,
        match: (d) => d.isDirectory() && d.name.startsWith('batch-'),
        maxFiles: VECTOR_MAX_FILES,
        maxAgeDays: VECTOR_MAX_AGE_DAYS,
        // Exclude current batch dir when present; safe to ignore when missing during tests
        exclude: this.vectorLogFile ? [path.dirname(this.vectorLogFile)] : undefined
      });
    } else {
      applyRetentionOnce(vectorLogDir, {
        includeDirs: false,
        match: (d) => d.isFile() && /^vector.*\.log$/.test(d.name),
        maxFiles: VECTOR_MAX_FILES,
        maxAgeDays: VECTOR_MAX_AGE_DAYS,
        // Exclude current log file if present to avoid pruning the active file
        exclude: this.vectorLogFile ? [this.vectorLogFile] : undefined
      });
    }

    this.vectorRetentionApplied = true;
  }
}
