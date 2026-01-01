import fs from 'fs';
import path from 'path';
import {
  BaseAdapterLogger,
  LogLevel,
  createIsoFilenameStamp,
  createIsoTimestamp,
  disableFileLogs,
  getBatchEnv
} from './base-logger.js';
import { applyRetentionOnce } from './retention-manager.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export abstract class BaseJsonLineFileLogger extends BaseAdapterLogger {
  private logFile?: string;
  private retentionApplied = false;
  private initialized = false;

  constructor(level: LogLevel = LogLevel.INFO, correlationId?: string | string[]) {
    super(level, correlationId);
  }

  protected abstract getTargetDir(): string;
  protected abstract getFilenamePrefix(): string;
  protected abstract getMaxFiles(): number;
  protected abstract getMaxAgeDays(): number | undefined;

  override debug(message: string, data?: any): void {
    super.debug(message, data);
    this.appendLine(LogLevel.DEBUG, message, data);
  }

  override info(message: string, data?: any): void {
    super.info(message, data);
    this.appendLine(LogLevel.INFO, message, data);
  }

  override warning(message: string, data?: any): void {
    super.warning(message, data);
    this.appendLine(LogLevel.WARNING, message, data);
  }

  override error(message: string, data?: any): void {
    super.error(message, data);
    this.appendLine(LogLevel.ERROR, message, data);
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    if (disableFileLogs) {
      this.initialized = true;
      return;
    }

    const dir = this.getTargetDir();
    const prefix = this.getFilenamePrefix();
    const { batchId, useBatchDir } = getBatchEnv();

    this.ensureDir(dir);

    if (batchId) {
      const baseDir = useBatchDir ? path.join(dir, `batch-${batchId}`) : dir;
      this.ensureDir(baseDir);
      this.logFile = useBatchDir
        ? path.join(baseDir, `${prefix}.log`)
        : path.join(baseDir, `${prefix}-batch-${batchId}.log`);
    } else {
      const timestamp = createIsoFilenameStamp();
      this.logFile = path.join(dir, `${prefix}-${timestamp}.log`);
    }

    this.initialized = true;
  }

  private appendLine(level: LogLevel, message: string, data?: any): void {
    this.ensureInitialized();
    if (!this.logFile || disableFileLogs) return;

    const timestamp = createIsoTimestamp();
    const correlationId = this.formatCorrelationId();
    const payload: Record<string, any> = {
      timestamp,
      level,
      message,
      ...(correlationId ? { correlationId } : {}),
      ...(data !== undefined ? { data } : {})
    };

    const serialized = JSON.stringify(payload, (key, value) => this.jsonReplacer(key, value));
    fs.appendFileSync(this.logFile, serialized + '\n');
    this.applyRetentionOnce();
  }

  private applyRetentionOnce(): void {
    if (this.retentionApplied || disableFileLogs) return;

    const dir = this.getTargetDir();
    const prefix = this.getFilenamePrefix();
    const maxFiles = this.getMaxFiles();
    const maxAgeDays = this.getMaxAgeDays();
    const { batchId, useBatchDir } = getBatchEnv();

    if (batchId && useBatchDir) {
      const excludePaths: string[] = [];
      if (this.logFile) excludePaths.push(path.dirname(this.logFile));

      applyRetentionOnce(dir, {
        includeDirs: true,
        match: (d) => d.isDirectory() && d.name.startsWith('batch-'),
        maxFiles,
        maxAgeDays,
        exclude: excludePaths
      });
    } else {
      const excludePaths: string[] = [];
      if (this.logFile) excludePaths.push(this.logFile);

      const fileRegex = new RegExp(`^${escapeRegExp(prefix)}.*\\.log$`);
      applyRetentionOnce(dir, {
        includeDirs: false,
        match: (d) => d.isFile() && fileRegex.test(d.name),
        maxFiles,
        maxAgeDays,
        exclude: excludePaths
      });
    }

    this.retentionApplied = true;
  }
}

