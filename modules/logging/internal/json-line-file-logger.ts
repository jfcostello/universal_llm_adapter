import fs from 'fs';
import path from 'path';
import {
  BaseAdapterLogger,
  type AdapterLoggerOptions,
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
  private batchId?: string;
  private useBatchDir = false;
  private currentBytes: number | null = null;
  private pendingWrites: string[] = [];
  private flushScheduled = false;
  private flushAgain = false;
  private flushPromise: Promise<void> | null = null;

  constructor(level: LogLevel = LogLevel.INFO, correlationId?: string | string[], options: AdapterLoggerOptions = {}) {
    super(level, correlationId, options);
  }

  protected abstract getTargetDir(): string;
  protected abstract getFilenamePrefix(): string;
  protected abstract getMaxFiles(): number;
  protected abstract getMaxAgeDays(): number | undefined;
  protected abstract getMaxBytes(): number | undefined;

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

  override async close(): Promise<void> {
    await this.flushPendingWrites();
    await super.close();
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
    this.batchId = batchId;
    this.useBatchDir = useBatchDir;
    this.currentBytes = null;

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

  private async ensureCurrentBytes(): Promise<number> {
    if (this.currentBytes !== null) return this.currentBytes;
    if (!this.logFile || disableFileLogs) {
      this.currentBytes = 0;
      return this.currentBytes;
    }

    let size = 0;
    try {
      const stat = await fs.promises.stat(this.logFile);
      size = typeof (stat as any).size === 'number' ? (stat as any).size : 0;
    } catch {
      // best-effort
    }

    this.currentBytes = size;
    return size;
  }

  private async rotateCurrentLogFile(): Promise<void> {
    if (!this.logFile || disableFileLogs) return;

    const dir = path.dirname(this.logFile);
    const prefix = this.getFilenamePrefix();
    const baseName = path.basename(this.logFile, '.log');
    const timestamp = createIsoFilenameStamp();

    const rotatedName = this.batchId && !this.useBatchDir
      ? `${baseName}-${timestamp}.log`
      : `${prefix}-${timestamp}.log`;

    try {
      await fs.promises.rename(this.logFile, path.join(dir, rotatedName));
    } catch {
      // best-effort
    }
  }

  private async maybeRotateForMaxBytes(bytesToWrite: number): Promise<void> {
    const maxBytes = this.getMaxBytes();
    if (!maxBytes || maxBytes <= 0) return;
    if (!this.batchId) return;
    if (!this.logFile || disableFileLogs) return;

    const current = await this.ensureCurrentBytes();
    if (current + bytesToWrite <= maxBytes) return;

    await this.rotateCurrentLogFile();
    this.currentBytes = 0;
    this.retentionApplied = false;
  }

  private scheduleFlush(): void {
    if (this.flushPromise) {
      this.flushAgain = true;
      return;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      void this.flushPendingWrites();
    });
  }

  private startFlush(): Promise<void> {
    if (this.flushPromise) {
      this.flushAgain = true;
      return this.flushPromise;
    }

    this.flushPromise = (async () => {
      while (true) {
        const next = this.pendingWrites.splice(0, this.pendingWrites.length);
        if (next.length === 0) {
          if (this.flushAgain) {
            this.flushAgain = false;
            continue;
          }
          break;
        }

        try {
          if (!this.logFile || disableFileLogs) continue;
          const batch = next.join('');
          const bytes = Buffer.byteLength(batch, 'utf8');
          const maxBytes = this.getMaxBytes();
          const shouldRotate = Boolean(this.batchId) && typeof maxBytes === 'number' && maxBytes > 0;
          if (shouldRotate) {
            await this.maybeRotateForMaxBytes(bytes);
          }
          await fs.promises.appendFile(this.logFile, batch);
          if (shouldRotate) {
            this.currentBytes = (await this.ensureCurrentBytes()) + bytes;
          }
        } catch {
          // Best-effort: drop log lines on write failure.
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.flushPromise = null;
      });

    return this.flushPromise;
  }

  private async flushPendingWrites(): Promise<void> {
    this.ensureInitialized();
    if (!this.logFile || disableFileLogs) return;
    await this.startFlush();
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
    this.pendingWrites.push(serialized + '\n');
    this.scheduleFlush();
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
