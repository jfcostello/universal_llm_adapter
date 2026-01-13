import path from 'path';

import {
  BaseJsonLineFileLogger,
  LogLevel,
  logDir
} from '../../../../../modules/logging/index.js';
import { VOICE_MAX_AGE_DAYS, VOICE_MAX_BYTES, VOICE_MAX_FILES } from './logging-retention.js';

export const voiceLogDir = path.join(logDir, 'voice');

export { VOICE_MAX_FILES, VOICE_MAX_AGE_DAYS, VOICE_MAX_BYTES };

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

let voiceLogger: VoiceLogger | null = null;

export function getVoiceLogger(correlationId?: string): VoiceLogger {
  if (!voiceLogger) {
    voiceLogger = new VoiceLogger(LogLevel.INFO);
  }
  return correlationId ? voiceLogger.withCorrelation(correlationId) : voiceLogger;
}

export async function closeVoiceLogger(): Promise<void> {
  if (!voiceLogger) return;
  await voiceLogger.close();
  voiceLogger = null;
}
