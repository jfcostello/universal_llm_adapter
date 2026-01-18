import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import type { TransformableInfo } from 'logform';

import {
  createSensitiveKeyMatcher,
  genericRedactHeaders,
  getSensitiveKeyPatternsFromDefaults,
  redactSensitiveValue,
  redactUrl
} from '../../../../security/index.js';
import { applyRetentionOnce } from '../../retention-manager.js';
import { getDefaults } from '../../../../../kernel/index.js';

import {
  ADAPTER_BATCH_MAX_FILES,
  ADAPTER_MAX_AGE_DAYS,
  ADAPTER_MAX_FILES,
  disableConsoleLogs,
  disableFileLogs,
  getBatchEnv,
  logDir
} from './config.js';
import { createAdapterFileFormat, hasCorrelationId, readCorrelationId } from './formatters.js';
import { LogLevel } from './log-level.js';
import { FlushingConsoleTransport, createAdapterFileTransport } from './transports.js';

export type AdapterLoggerOptions = {
  /**
   * When provided, this instance reuses an existing winston logger (and its transports)
   * instead of creating new transports. Used for correlated logger instances.
   */
  sharedLogger?: winston.Logger;
};

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
    this.shouldRedactKey = createSensitiveKeyMatcher(getSensitiveKeyPatternsFromDefaults());

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
          const timestamp = new Date().toISOString();
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

    if (typeof value === 'string' && /^(https?|wss?):[/]{2}/.test(value)) {
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
    const stackLines = error.stack ? error.stack.split('\\n').slice(0, 5) : undefined;
    return {
      name: error.name,
      message: error.message,
      stack: stackLines ? stackLines.join('\\n') : undefined
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
