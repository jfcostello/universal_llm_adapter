import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import DailyRotateFile from 'winston-daily-rotate-file';
import TransportStream from 'winston-transport';
import type { TransformableInfo } from 'logform';
import { genericRedactHeaders } from '../../utils/security/redaction.js';
import { enforceRetention, readEnvFloat, readEnvInt } from '../../utils/logging/retention.js';

export const disableFileLogs = process.env.LLM_ADAPTER_DISABLE_FILE_LOGS === '1';
export const disableConsoleLogs = process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS === '1';

export const logDir = path.join(process.cwd(), 'logs');
export const llmLogDir = path.join(logDir, 'llm');
export const embeddingLogDir = path.join(logDir, 'embedding');
export const vectorLogDir = path.join(logDir, 'vector');

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

function createAdapterFileFormat(correlationId?: string): winston.Logform.Format {
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
    if (correlationId) logObj.correlationId = correlationId;
    if (Object.keys(data).length > 0) {
      Object.assign(logObj, data);
    }
    return `[${timestamp}]: ${JSON.stringify(logObj)}`;
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
  protected correlationId?: string;
  protected level: LogLevel;

  /* istanbul ignore next */
  constructor(level: LogLevel = LogLevel.INFO, correlationId?: string) {
    this.level = level;
    this.correlationId = correlationId;

    const transports: winston.transport[] = [];

    if (!disableFileLogs) {
      this.ensureDir(logDir);
      const { batchId } = getBatchEnv();
      const fileFormat = createAdapterFileFormat(this.correlationId);

      if (batchId) {
        enforceRetention(logDir, {
          includeDirs: false,
          match: (d) => d.isFile() && /^adapter-batch-.*\.log/.test(d.name),
          maxFiles: ADAPTER_BATCH_MAX_FILES,
          maxAgeDays: ADAPTER_MAX_AGE_DAYS,
          exclude: [path.join(logDir, `adapter-batch-${batchId}.log`)]
        });
      }

      transports.push(createAdapterFileTransport({ batchId, format: fileFormat }));
    }

    /* istanbul ignore else */
    if (!disableConsoleLogs) {
      const consoleTransport = new FlushingConsoleTransport({
        level: level,
        stderrLevels: ['error', 'warn'],
        format: winston.format.printf(({ level: lvl, message, ...data }) => {
          const timestamp = createIsoTimestamp();
          const logObj: any = { type: 'log', timestamp, level: lvl, message };
          if (this.correlationId) logObj.correlationId = this.correlationId;
          if (Object.keys(data).length > 0) logObj.data = data;
          return JSON.stringify(logObj);
        })
      });

      transports.push(consoleTransport);
    }

    this.logger = winston.createLogger({ transports });
  }

  withCorrelation(correlationId: string): this {
    const ctor = this.constructor as new (level?: LogLevel, correlationId?: string) => this;
    return new ctor(this.level, correlationId);
  }

  debug(message: string, data?: any): void {
    this.logger.debug(message, data || {});
  }

  debugRaw(payload: any): void {
    const serialized = typeof payload === 'string'
      ? payload
      : JSON.stringify(payload, this.jsonReplacer);
    this.logger.debug('Raw payload', { raw: serialized });
  }

  info(message: string, data?: any): void {
    this.logger.info(message, data || {});
  }

  warning(message: string, data?: any): void {
    this.logger.warn(message, data || {});
  }

  error(message: string, data?: any): void {
    this.logger.error(message, this.normalizeErrorPayload(data));
  }

  async close(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.performPostCloseRetention();
        resolve();
      };

      const timeout = setTimeout(() => done(), 2000);
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

  protected jsonReplacer(_key: string, value: any): any {
    if (value instanceof Buffer || value instanceof Uint8Array) {
      return Buffer.from(value).toString('base64');
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

    enforceRetention(logDir, {
      includeDirs: false,
      match: (d) => d.isFile() && /^adapter-batch-.*\.log/.test(d.name),
      maxFiles: ADAPTER_BATCH_MAX_FILES,
      maxAgeDays: ADAPTER_MAX_AGE_DAYS
    });

    enforceRetention(logDir, {
      includeDirs: false,
      match: (d) => d.isFile() && /^adapter-\d{4}-\d{2}-\d{2}.*\.log$/.test(d.name),
      maxFiles: ADAPTER_MAX_FILES,
      maxAgeDays: ADAPTER_MAX_AGE_DAYS
    });
  }
}
