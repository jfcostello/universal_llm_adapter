import { BaseJsonLineFileLogger } from './json-line-file-logger.js';
import { voiceLogDir, VOICE_MAX_AGE_DAYS, VOICE_MAX_BYTES, VOICE_MAX_FILES } from './base-logger.js';

export class VoiceLogger extends BaseJsonLineFileLogger {
  protected getTargetDir(): string {
    return voiceLogDir;
  }

  protected getFilenamePrefix(): string {
    return 'voice';
  }

  protected getMaxFiles(): number {
    return VOICE_MAX_FILES;
  }

  protected getMaxAgeDays(): number | undefined {
    return VOICE_MAX_AGE_DAYS;
  }

  protected getMaxBytes(): number | undefined {
    return VOICE_MAX_BYTES > 0 ? VOICE_MAX_BYTES : undefined;
  }
}
