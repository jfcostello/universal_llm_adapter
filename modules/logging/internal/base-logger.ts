import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import DailyRotateFile from 'winston-daily-rotate-file';
import TransportStream from 'winston-transport';
import type { TransformableInfo } from 'logform';
import { createSensitiveKeyMatcher, genericRedactHeaders, redactSensitiveValue, redactUrl } from '../../security/index.js';
import { readEnvFloat, readEnvInt } from './retention.js';
import { applyRetentionOnce } from './retention-manager.js';
import { getDefaults } from '../../../kernel/index.js';

export const disableFileLogs = process.env.LLM_ADAPTER_DISABLE_FILE_LOGS === '1';
export const disableConsoleLogs = process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS === '1';

export const logDir = path.join(process.cwd(), 'logs');
export const llmLogDir = path.join(logDir, 'llm');
export const embeddingLogDir = path.join(logDir, 'embedding');
export const vectorLogDir = path.join(logDir, 'vector');
export const voiceLogDir = path.join(logDir, 'voice');
export const realtimeLogDir = path.join(logDir, 'realtime');

// Retention configuration (env overrides)
const DEFAULT_MAX_FILES = readEnvInt('LLM_ADAPTER_LOG_MAX_FILES', 50);
const DEFAULT_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_LOG_MAX_AGE_DAYS');

export const LLM_MAX_FILES = readEnvInt('LLM_ADAPTER_LLM_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const LLM_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_LLM_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);

export const ADAPTER_MAX_FILES = readEnvInt('LLM_ADAPTER_ADAPTER_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const ADAPTER_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_ADAPTER_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);
export const ADAPTER_BATCH_MAX_FILES = readEnvInt('LLM_ADAPTER_BATCH_LOG_MAX_FILES', ADAPTER_MAX_FILES);

export const EMBEDDING_MAX_FILES = readEnvInt('LLM_ADAPTER_EMBEDDING_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const EMBEDDING_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_EMBEDDING_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);

export const VECTOR_MAX_FILES = readEnvInt('LLM_ADAPTER_VECTOR_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const VECTOR_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_VECTOR_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);

export const VOICE_MAX_FILES = readEnvInt('LLM_ADAPTER_VOICE_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const VOICE_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_VOICE_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);
export const VOICE_MAX_BYTES = readEnvInt('LLM_ADAPTER_VOICE_LOG_MAX_BYTES', 0);

export const REALTIME_MAX_FILES = readEnvInt('LLM_ADAPTER_REALTIME_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const REALTIME_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_REALTIME_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);
export const REALTIME_MAX_BYTES = readEnvInt('LLM_ADAPTER_REALTIME_LOG_MAX_BYTES', 0);

const BATCH_FILE_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const BATCH_FILE_MAX_FILES = ADAPTER_BATCH_MAX_FILES;

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
}

export function getBatchEnv(): { batchId?: string; useBatchDir: boolean } {
  const raw = process.env.LLM_ADAPTER_BATCH_ID;
  const batchId = raw ? sanitizeId(raw) : undefined;
  const useDir = process.env.LLM_ADAPTER_BATCH_DIR === '1';
  return { batchId, useBatchDir: useDir };
}

export function createIsoTimestamp(): string {
  return new Date().toISOString();
}

export function createIsoFilenameStamp(): string {
  return createIsoTimestamp().replace(/[:.]/g, '-');
}

/**
 * Custom Winston transport that writes to stdout/stderr with immediate flushing
 * to prevent buffering issues when output is piped.
 */
export class FlushingConsoleTransport extends TransportStream {
  private stderrLevels: Set<string>;

  constructor(options: any = {}) {
    super(options);
    this.stderrLevels = new Set(options.stderrLevels || ['error', 'warn']);
  }

  log(info: any, callback: () => void): void {
    setImmediate(() => {
      const output = this.format?.transform(info, this.format.options);
      if (!output) {
        callback();
        return;
      }

      const message = (output as any)[Symbol.for('message')] || JSON.stringify(output);
      const useStderr = this.stderrLevels.has(info.level);
      const stream = useStderr ? process.stderr : process.stdout;

      stream.write(message + '\n', () => {
        callback();
      });
    });
  }
}

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARNING = 'warn',
  ERROR = 'error'
}

export type AdapterLoggerOptions = {
  /**
   * When provided, this instance reuses an existing winston logger (and its transports)
   * instead of creating new transports. Used for correlated logger instances.
   */
  sharedLogger?: winston.Logger;
};

function hasCorrelationId(correlationId?: string | string[]): boolean {
  if (!correlationId) return false;
  if (Array.isArray(correlationId)) return correlationId.length > 0;
  return true;
}

function readCorrelationId(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value as string[];
  return undefined;
}

function createAdapterFileFormat(
  correlationId: string | string[] | undefined,
  jsonReplacer: ((key: string, value: any) => any) | undefined
): winston.Logform.Format {
  return winston.format.printf((info: TransformableInfo) => {
    const { level, message, ...data } = info as TransformableInfo & {
      level: unknown;
      message?: unknown;
    };
    const timestamp = createIsoTimestamp();
    const logLevel = typeof level === 'string' ? level : String(level);
    const resolvedMessage =
      typeof message === 'string' ? message : JSON.stringify(message ?? '');
    const logObj: Record<string, unknown> = { level: logLevel, message: resolvedMessage };
    if (hasCorrelationId(correlationId)) logObj.correlationId = correlationId;
    if (Object.keys(data).length > 0) {
      Object.assign(logObj, data);
    }
    return `[${timestamp}]: ${JSON.stringify(logObj, jsonReplacer)}`;
  });
}

function createAdapterFileTransport(options: {
  batchId?: string;
  format: winston.Logform.Format;
}): winston.transport {
  const { batchId, format } = options;
  if (batchId) {
    const filename = path.join(logDir, `adapter-batch-${batchId}.log`);
    return new winston.transports.File({
      filename,
      level: LogLevel.DEBUG,
      maxsize: BATCH_FILE_MAX_SIZE_BYTES,
      maxFiles: BATCH_FILE_MAX_FILES,
      tailable: true,
      format
    });
  }

  return new DailyRotateFile({
    filename: path.join(logDir, 'adapter-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '5m',
    maxFiles: String(ADAPTER_MAX_FILES),
    level: LogLevel.DEBUG,
    format
  });
}

export class BaseAdapterLogger {
  protected logger: winston.Logger;
  protected correlationId?: string | string[];
  protected level: LogLevel;
  private ownsWinstonLogger: boolean;
  private shouldRedactKey: (key: string) => boolean;

  constructor(level: LogLevel = LogLevel.INFO, correlationId?: string | string[], options: AdapterLoggerOptions = {}) {
    this.level = level;
    this.correlationId = correlationId;
    this.ownsWinstonLogger = !options.sharedLogger;
    const sensitiveKeys = (getDefaults() as any)?.security?.redaction?.sensitiveKeys;
    this.shouldRedactKey = createSensitiveKeyMatcher(Array.isArray(sensitiveKeys) ? sensitiveKeys : []);

    if (options.sharedLogger) {
      this.logger = options.sharedLogger;
      return;
    }

    const transports: winston.transport[] = [];
    const jsonReplacer = (key: string, value: any) => this.jsonReplacer(key, value);

    if (!disableFileLogs) {
      this.ensureDir(logDir);
      const { batchId } = getBatchEnv();
      const fileFormat = createAdapterFileFormat(this.correlationId, jsonReplacer);

      if (batchId) {
        applyRetentionOnce(logDir, {
          includeDirs: false,
          match: (d) => d.isFile() && /^adapter-batch-.*\.log/.test(d.name),
          maxFiles: ADAPTER_BATCH_MAX_FILES,
          maxAgeDays: ADAPTER_MAX_AGE_DAYS,
          exclude: [path.join(logDir, `adapter-batch-${batchId}.log`)]
        });
      }

      transports.push(createAdapterFileTransport({ batchId, format: fileFormat }));
    }

    if (!disableConsoleLogs) {
      const consoleTransport = new FlushingConsoleTransport({
        level: level,
        stderrLevels: ['error', 'warn'],
        format: winston.format.printf((info: TransformableInfo) => {
          const { level: rawLevel, message, correlationId: rawCorrelationId, ...data } = info as TransformableInfo & {
            level: unknown;
            correlationId?: unknown;
          };
          const lvl = typeof rawLevel === 'string' ? rawLevel : String(rawLevel);
          const timestamp = createIsoTimestamp();
          const logObj: any = { type: 'log', timestamp, level: lvl, message };
          const infoCorrelationId = readCorrelationId(rawCorrelationId);
          const resolvedCorrelationId =
            hasCorrelationId(infoCorrelationId)
              ? infoCorrelationId
              : (hasCorrelationId(this.correlationId) ? this.correlationId : undefined);
          if (resolvedCorrelationId !== undefined) logObj.correlationId = resolvedCorrelationId;
          if (Object.keys(data).length > 0) logObj.data = data;
          return JSON.stringify(logObj, jsonReplacer);
        })
      });

      transports.push(consoleTransport);
    }

    this.logger = winston.createLogger({ transports });
  }

  withCorrelation(correlationId: string | string[]): this {
    const ctor = this.constructor as new (
      level?: LogLevel,
      correlationId?: string | string[],
      options?: AdapterLoggerOptions
    ) => this;
    return new ctor(this.level, correlationId, { sharedLogger: this.logger });
  }

  private withWinstonCorrelation(data: any): any {
    if (this.ownsWinstonLogger) return data || {};
    if (!hasCorrelationId(this.correlationId)) return data || {};

    const base = data || {};
    if (!base || typeof base !== 'object' || Array.isArray(base)) {
      return { data: base, correlationId: this.correlationId };
    }
    if ((base as any).correlationId !== undefined) return base;
    return { ...base, correlationId: this.correlationId };
  }

  /**
   * Format correlationId for human-readable display (e.g., in detail logs).
   * Returns comma-separated string for arrays, or the string itself.
   * Returns undefined if no correlationId is set or array is empty.
   */
  protected formatCorrelationId(): string | undefined {
    if (!this.correlationId) return undefined;
    if (Array.isArray(this.correlationId)) {
      return this.correlationId.length > 0 ? this.correlationId.join(', ') : undefined;
    }
    return this.correlationId;
  }

  debug(message: string, data?: any): void {
    this.logger.debug(message, this.withWinstonCorrelation(data));
  }

  debugRaw(payload: any): void {
    const serialized = typeof payload === 'string'
      ? payload
      : JSON.stringify(payload, (key, value) => this.jsonReplacer(key, value));
    this.logger.debug('Raw payload', this.withWinstonCorrelation({ raw: serialized }));
  }

  info(message: string, data?: any): void {
    this.logger.info(message, this.withWinstonCorrelation(data));
  }

  warning(message: string, data?: any): void {
    this.logger.warn(message, this.withWinstonCorrelation(data));
  }

  error(message: string, data?: any): void {
    this.logger.error(message, this.withWinstonCorrelation(this.normalizeErrorPayload(data)));
  }

  async close(): Promise<void> {
    if (!this.ownsWinstonLogger) return;
    return new Promise<void>((resolve) => {
      const done = () => {
        this.performPostCloseRetention();
        resolve();
      };

      const timeout = setTimeout(() => done(), getDefaults().timeouts.loggerFlush);
      const transports = this.logger.transports;

      if (transports.length === 0) {
        clearTimeout(timeout);
        done();
        return;
      }

      let finishedCount = 0;
      const checkFinished = () => {
        finishedCount++;
        if (finishedCount >= transports.length) {
          clearTimeout(timeout);
          done();
        }
      };

      transports.forEach((transport) => {
        transport.once('finish', checkFinished);
      });

      this.logger.close();
    });
  }

  protected redactHeaders(headers: Record<string, any>): Record<string, any> {
    return genericRedactHeaders(headers);
  }

  protected jsonReplacer(key: string, value: any): any {
    const lowerKey = key.toLowerCase();

    if (lowerKey.endsWith('base64')) {
      return '[REDACTED_BASE64]';
    }

    if (lowerKey === 'authorization') {
      if (typeof value === 'string') {
        return this.redactHeaders({ Authorization: value }).Authorization;
      }
      return '[REDACTED_AUTH]';
    }

    if (this.shouldRedactKey(key)) {
      return redactSensitiveValue(value);
    }

    if (value instanceof Buffer || value instanceof Uint8Array) {
      return Buffer.from(value).toString('base64');
    }

    if (typeof value === 'string' && /^(https?|wss?):\/\//.test(value)) {
      return redactUrl(value);
    }

    return value;
  }

  protected normalizeErrorPayload(data: any): any {
    if (data === undefined || data === null) {
      return {};
    }

    if (data instanceof Error) {
      return { error: this.formatError(data) };
    }

    if (typeof data === 'object') {
      if (Array.isArray(data)) {
        return data.map(item => (item instanceof Error ? this.formatError(item) : item));
      }

      const normalized: Record<string, any> = { ...data };
      for (const [key, value] of Object.entries(normalized)) {
        if (value instanceof Error) {
          normalized[key] = this.formatError(value);
        }
      }
      return normalized;
    }

    return { error: String(data) };
  }

  protected formatError(error: Error): Record<string, any> {
    const stackLines = error.stack ? error.stack.split('\n').slice(0, 5) : undefined;
    return {
      name: error.name,
      message: error.message,
      stack: stackLines ? stackLines.join('\n') : undefined
    };
  }

  protected ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  protected performPostCloseRetention(): void {
    if (disableFileLogs) return;

    applyRetentionOnce(logDir, {
      includeDirs: false,
      match: (d) => d.isFile() && /^adapter-batch-.*\.log/.test(d.name),
      maxFiles: ADAPTER_BATCH_MAX_FILES,
      maxAgeDays: ADAPTER_MAX_AGE_DAYS
    });

    applyRetentionOnce(logDir, {
      includeDirs: false,
      match: (d) => d.isFile() && /^adapter-\d{4}-\d{2}-\d{2}.*\.log$/.test(d.name),
      maxFiles: ADAPTER_MAX_FILES,
      maxAgeDays: ADAPTER_MAX_AGE_DAYS
    });
  }
}
