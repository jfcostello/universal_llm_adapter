import * as winston from 'winston';
import * as path from 'path';
import DailyRotateFile from 'winston-daily-rotate-file';
import TransportStream from 'winston-transport';

import {
  ADAPTER_BATCH_MAX_FILES,
  ADAPTER_MAX_FILES,
  logDir
} from './config.js';
import { LogLevel } from './log-level.js';

const BATCH_FILE_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const BATCH_FILE_MAX_FILES = ADAPTER_BATCH_MAX_FILES;

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

export function createAdapterFileTransport(options: {
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

