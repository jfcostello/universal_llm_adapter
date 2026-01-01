import { BaseJsonLineFileLogger } from './json-line-file-logger.js';
import { realtimeLogDir, REALTIME_MAX_AGE_DAYS, REALTIME_MAX_BYTES, REALTIME_MAX_FILES } from './base-logger.js';

export class RealtimeLogger extends BaseJsonLineFileLogger {
  protected getTargetDir(): string {
    return realtimeLogDir;
  }

  protected getFilenamePrefix(): string {
    return 'realtime';
  }

  protected getMaxFiles(): number {
    return REALTIME_MAX_FILES;
  }

  protected getMaxAgeDays(): number | undefined {
    return REALTIME_MAX_AGE_DAYS;
  }

  protected getMaxBytes(): number | undefined {
    return REALTIME_MAX_BYTES > 0 ? REALTIME_MAX_BYTES : undefined;
  }
}
