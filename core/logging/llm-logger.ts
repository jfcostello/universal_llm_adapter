import fs from 'fs';
import path from 'path';
import {
  BaseAdapterLogger,
  LogLevel,
  createIsoFilenameStamp,
  createIsoTimestamp,
  disableFileLogs,
  llmLogDir,
  getBatchEnv,
  LLM_MAX_FILES,
  LLM_MAX_AGE_DAYS
} from './base-logger.js';
import { applyRetentionOnce } from '../../utils/logging/retention-manager.js';

export class LLMLogger extends BaseAdapterLogger {
  private llmLogFile?: string;
  private llmRetentionApplied = false;
  private initialized = false;

  constructor(level: LogLevel = LogLevel.INFO, correlationId?: string | string[]) {
    super(level, correlationId);
  }

  logLLMRequest(data: {
    url: string;
    method: string;
    headers: Record<string, any>;
    body: any;
    provider?: string;
    model?: string;
  }): void {
    this.ensureInitialized();
    if (!this.llmLogFile || disableFileLogs) return;

    const correlationIdStr = this.formatCorrelationId();
    const separator = '\n' + '='.repeat(80) + '\n';
    const log = [
      separator,
      '>>> OUTGOING REQUEST >>>',
      separator,
      `Timestamp: ${createIsoTimestamp()}`,
      correlationIdStr ? `CorrelationId: ${correlationIdStr}` : null,
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

    fs.appendFileSync(this.llmLogFile, log);
    this.applyLlmRetentionOnce();
  }

  logLLMResponse(data: {
    status: number;
    statusText?: string;
    headers: Record<string, any>;
    body: any;
    duration?: number;
    provider?: string;
    model?: string;
  }): void {
    this.ensureInitialized();
    if (!this.llmLogFile || disableFileLogs) return;

    const correlationIdStr = this.formatCorrelationId();
    const separator = '\n' + '='.repeat(80) + '\n';
    const log = [
      separator,
      '<<< INCOMING RESPONSE <<<',
      separator,
      `Timestamp: ${createIsoTimestamp()}`,
      correlationIdStr ? `CorrelationId: ${correlationIdStr}` : null,
      `Status: ${data.status} ${data.statusText || ''}`,
      data.provider ? `Provider: ${data.provider}` : null,
      data.model ? `Model: ${data.model}` : null,
      data.duration !== undefined ? `Duration: ${data.duration}ms` : null,
      '',
      '--- HEADERS ---',
      JSON.stringify(data.headers, null, 2),
      '',
      '--- BODY ---',
      JSON.stringify(data.body, null, 2),
      separator,
      ''
    ].filter(Boolean).join('\n');

    fs.appendFileSync(this.llmLogFile, log);
    this.applyLlmRetentionOnce();
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    if (disableFileLogs) {
      this.initialized = true;
      return;
    }

    const { batchId, useBatchDir } = getBatchEnv();
    this.ensureDir(llmLogDir);

    if (batchId) {
      const baseDir = useBatchDir ? path.join(llmLogDir, `batch-${batchId}`) : llmLogDir;
      this.ensureDir(baseDir);
      this.llmLogFile = useBatchDir
        ? path.join(baseDir, 'llm.log')
        : path.join(baseDir, `llm-batch-${batchId}.log`);
    } else {
      const timestamp = createIsoFilenameStamp();
      this.llmLogFile = path.join(llmLogDir, `llm-${timestamp}.log`);
    }

    this.initialized = true;
  }

  private applyLlmRetentionOnce(): void {
    if (this.llmRetentionApplied || disableFileLogs) return;
    const { batchId, useBatchDir } = getBatchEnv();

    /* istanbul ignore else */
    if (batchId && useBatchDir) {
      applyRetentionOnce(llmLogDir, {
        includeDirs: true,
        match: (d) => d.isDirectory() && d.name.startsWith('batch-'),
        maxFiles: LLM_MAX_FILES,
        maxAgeDays: LLM_MAX_AGE_DAYS,
        // Exclude current batch dir when present; safe to ignore when missing during tests
        /* istanbul ignore next */
        exclude: this.llmLogFile ? [path.dirname(this.llmLogFile)] : undefined
      });
    } else {
      applyRetentionOnce(llmLogDir, {
        includeDirs: false,
        match: (d) => d.isFile() && /^llm.*\.log$/.test(d.name),
        maxFiles: LLM_MAX_FILES,
        maxAgeDays: LLM_MAX_AGE_DAYS,
        // Exclude current log file if present to avoid pruning the active file
        /* istanbul ignore next */
        exclude: this.llmLogFile ? [this.llmLogFile] : undefined
      });
    }

    this.llmRetentionApplied = true;
  }
}
