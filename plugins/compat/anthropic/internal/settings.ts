import type { LLMCallSettings } from '../../../../modules/kernel/index.js';

export function serializeSettings(settings: LLMCallSettings): any {
  const result: any = {};

  if (settings.temperature !== undefined) {
    result.temperature = settings.temperature;
  }
  if (settings.topP !== undefined) {
    result.top_p = settings.topP;
  }
  if (settings.stop) {
    result.stop_sequences = settings.stop;
  }

  return result;
}

