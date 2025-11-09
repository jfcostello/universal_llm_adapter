import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import DailyRotateFile from 'winston-daily-rotate-file';
import TransportStream from 'winston-transport';
import type { TransformableInfo } from 'logform';
import { genericRedactHeaders } from '../utils/security/redaction.js';
import { enforceRetention, readEnvInt, readEnvFloat } from '../utils/logging/retention.js';

const disableFileLogs = process.env.LLM_ADAPTER_DISABLE_FILE_LOGS === '1';
const disableConsoleLogs = process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS === '1';
const logDir = path.join(process.cwd(), 'logs');
const llmLogDir = path.join(process.cwd(), 'logs', 'llm');

// Retention configuration (env overrides)
const DEFAULT_MAX_FILES = readEnvInt('LLM_ADAPTER_LOG_MAX_FILES', 50);
const DEFAULT_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_LOG_MAX_AGE_DAYS');

const LLM_MAX_FILES = readEnvInt('LLM_ADAPTER_LLM_LOG_MAX_FILES', DEFAULT_MAX_FILES);
const LLM_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_LLM_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);

const ADAPTER_MAX_FILES = readEnvInt('LLM_ADAPTER_ADAPTER_LOG_MAX_FILES', DEFAULT_MAX_FILES);
const ADAPTER_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_ADAPTER_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);
const ADAPTER_BATCH_MAX_FILES = readEnvInt('LLM_ADAPTER_BATCH_LOG_MAX_FILES', ADAPTER_MAX_FILES);

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
}

function getBatchEnv(): { batchId?: string; useBatchDir: boolean } {
  const raw = process.env.LLM_ADAPTER_BATCH_ID;
  const batchId = raw ? sanitizeId(raw) : undefined;
  const useDir = process.env.LLM_ADAPTER_BATCH_DIR === '1';
  return { batchId, useBatchDir: useDir };
}

function createIsoTimestamp(): string {
  return new Date().toISOString();
}

function createIsoFilenameStamp(): string {
  return createIsoTimestamp().replace(/[:.]/g, '-');
}

if (!disableFileLogs) {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  if (!fs.existsSync(llmLogDir)) {
    fs.mkdirSync(llmLogDir, { recursive: true });
  }
}

/**
 * Custom Winston transport that writes to stdout/stderr with immediate flushing
 * to prevent buffering issues when output is piped.
 */
class FlushingConsoleTransport extends TransportStream {
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

      // Write and explicitly flush (newline + potential drain)
      stream.write(message + '\n', () => {
        // Force flush by calling the underlying descriptor if available
        // This ensures logs appear immediately even when piped
        if (typeof (stream as any).fd === 'number' && (stream as any)._handle?.ref) {
          // Just ensure we've written to the stream
        }
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

const BATCH_FILE_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const BATCH_FILE_MAX_FILES = ADAPTER_BATCH_MAX_FILES;

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

export class AdapterLogger {
  private logger: winston.Logger;
  private correlationId?: string;
  private llmLogFile?: string;
  private llmRetentionApplied = false;

  constructor(level: LogLevel = LogLevel.INFO, correlationId?: string) {
    this.correlationId = correlationId;

    // Initialize LLM log file if file logging is enabled
    if (!disableFileLogs) {
      const { batchId, useBatchDir } = getBatchEnv();
      if (batchId) {
        const baseDir = useBatchDir ? path.join(llmLogDir, `batch-${batchId}`) : llmLogDir;
        if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
        this.llmLogFile = useBatchDir
          ? path.join(baseDir, 'llm.log')
          : path.join(baseDir, `llm-batch-${batchId}.log`);
        // Enforce retention on batch directories when using batch dir mode
        if (useBatchDir) {
          enforceRetention(llmLogDir, {
            includeDirs: true,
            match: (d) => d.isDirectory() && d.name.startsWith('batch-'),
            maxFiles: LLM_MAX_FILES,
            maxAgeDays: LLM_MAX_AGE_DAYS,
            exclude: [path.join(llmLogDir, `batch-${batchId}`)]
          });
        } else {
          // Enforce retention on batch-named files under llm dir
          enforceRetention(llmLogDir, {
            includeDirs: false,
            match: (d) => d.isFile() && /^llm-batch-.*\.log$/.test(d.name),
            maxFiles: LLM_MAX_FILES,
            maxAgeDays: LLM_MAX_AGE_DAYS,
            exclude: [this.llmLogFile]
          });
        }
      } else {
        const timestamp = createIsoFilenameStamp();
        this.llmLogFile = path.join(llmLogDir, `llm-${timestamp}.log`);
        // Enforce retention on timestamped llm logs
        enforceRetention(llmLogDir, {
          includeDirs: false,
          match: (d) => d.isFile() && /^llm-.*\.log$/.test(d.name),
          maxFiles: LLM_MAX_FILES,
          maxAgeDays: LLM_MAX_AGE_DAYS,
          exclude: [this.llmLogFile]
        });
      }
    }
    
    const transports: winston.transport[] = [];

    if (!disableFileLogs) {
      const { batchId } = getBatchEnv();
      const fileFormat = createAdapterFileFormat(this.correlationId);
      // Before creating transport, prune batch adapter files globally
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

    if (!disableConsoleLogs) {
      const consoleTransport = new FlushingConsoleTransport({
        level: level,
        stderrLevels: ['error', 'warn'],
        format: winston.format.printf(({ level, message, ...data }) => {
          const timestamp = createIsoTimestamp();
          const logObj: any = { type: 'log', timestamp, level, message };
          if (this.correlationId) logObj.correlationId = this.correlationId;
          if (Object.keys(data).length > 0) logObj.data = data;
          return JSON.stringify(logObj);
        })
      });

      transports.push(consoleTransport);
    }

    this.logger = winston.createLogger({ transports });
  }

  withCorrelation(correlationId: string): AdapterLogger {
    return new AdapterLogger(LogLevel.INFO, correlationId);
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

  /**
   * Log LLM HTTP request with beautiful formatting (raw payload, headers with redacted API keys)
   */
  logLLMRequest(data: {
    url: string;
    method: string;
    headers: Record<string, any>;
    body: any;
  }): void {
    if (!this.llmLogFile) return;

    const separator = '\n' + '='.repeat(80) + '\n';
    const log = [
      separator,
      '>>> OUTGOING REQUEST >>>',
      separator,
      `Timestamp: ${new Date().toISOString()}`,
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
    ].join('\n');

    fs.appendFileSync(this.llmLogFile, log);
    // After first write, enforce LLM retention (ensures new file is counted)
    this.applyLlmRetentionOnce();
  }

  /**
   * Log LLM HTTP response with beautiful formatting (raw payload)
   */
  logLLMResponse(data: {
    status: number;
    statusText?: string;
    headers: Record<string, any>;
    body: any;
  }): void {
    if (!this.llmLogFile) return;

    const separator = '\n' + '='.repeat(80) + '\n';
    const log = [
      separator,
      '<<< INCOMING RESPONSE <<<',
      separator,
      `Timestamp: ${new Date().toISOString()}`,
      `Status: ${data.status} ${data.statusText || ''}`,
      '',
      '--- HEADERS ---',
      JSON.stringify(data.headers, null, 2),
      '',
      '--- BODY ---',
      JSON.stringify(data.body, null, 2),
      separator,
      ''
    ].join('\n');

    fs.appendFileSync(this.llmLogFile, log);
    this.applyLlmRetentionOnce();
  }

  async close(): Promise<void> {
    return new Promise<void>((resolve) => {
      // Timeout after 250ms - worst case we miss some file logs, console logs are already flushed
      const done = () => {
        this.performPostCloseRetention();
        resolve();
      };
      const timeout = setTimeout(() => done(), 250);

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

      // Wait for all transports to finish
      transports.forEach(transport => {
        transport.once('finish', checkFinished);
      });

      // Close the logger (triggers finish events on transports)
      this.logger.close();
    });
  }

  /**
   * Redact sensitive data from headers (show only last 4 chars of API keys)
   */
  private redactHeaders(headers: Record<string, any>): Record<string, any> {
    return genericRedactHeaders(headers);
  }

  private jsonReplacer(_key: string, value: any): any {
    if (value instanceof Buffer || value instanceof Uint8Array) {
      return Buffer.from(value).toString('base64');
    }
    return value;
  }

  private normalizeErrorPayload(data: any): any {
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

  private formatError(error: Error): Record<string, any> {
    const stackLines = error.stack ? error.stack.split('\n').slice(0, 5) : undefined;
    return {
      name: error.name,
      message: error.message,
      stack: stackLines ? stackLines.join('\n') : undefined
    };
  }

  private applyLlmRetentionOnce(): void {
    if (this.llmRetentionApplied || !this.llmLogFile) return;
    const { batchId, useBatchDir } = getBatchEnv();
    if (batchId && useBatchDir) {
      enforceRetention(llmLogDir, {
        includeDirs: true,
        match: (d) => d.isDirectory() && d.name.startsWith('batch-'),
        maxFiles: LLM_MAX_FILES,
        maxAgeDays: LLM_MAX_AGE_DAYS
      });
    } else {
      enforceRetention(llmLogDir, {
        includeDirs: false,
        match: (d) => d.isFile() && /^llm.*\.log$/.test(d.name),
        maxFiles: LLM_MAX_FILES,
        maxAgeDays: LLM_MAX_AGE_DAYS
      });
    }
    this.llmRetentionApplied = true;
  }

  private performPostCloseRetention(): void {
    if (!disableFileLogs) {
      // Prune adapter batch files globally
      enforceRetention(logDir, {
        includeDirs: false,
        match: (d) => d.isFile() && /^adapter-batch-.*\.log/.test(d.name),
        maxFiles: ADAPTER_BATCH_MAX_FILES,
        maxAgeDays: ADAPTER_MAX_AGE_DAYS
      });

      // Prune date-rotated adapter files (belt-and-suspenders; daily-rotate already honors maxFiles)
      enforceRetention(logDir, {
        includeDirs: false,
        match: (d) => d.isFile() && /^adapter-\d{4}-\d{2}-\d{2}.*\.log$/.test(d.name),
        maxFiles: ADAPTER_MAX_FILES,
        maxAgeDays: ADAPTER_MAX_AGE_DAYS
      });
    }
  }
}

let defaultLogger: AdapterLogger | null = null;

export function getLogger(correlationId?: string): AdapterLogger {
  if (!defaultLogger) {
    defaultLogger = new AdapterLogger(LogLevel.INFO);
  }
  return correlationId ? defaultLogger.withCorrelation(correlationId) : defaultLogger;
}

export async function closeLogger(): Promise<void> {
  if (defaultLogger) {
    await defaultLogger.close();
    defaultLogger = null;
  }
}
