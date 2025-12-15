import type { LLMCallSettings } from '../../../../modules/kernel/index.js';

/**
 * Convert settings to Google generation config fields.
 */
export function serializeSettings(settings: LLMCallSettings): any {
  const config: any = {};

  if (settings.temperature !== undefined) config.temperature = settings.temperature;
  if (settings.topP !== undefined) config.topP = settings.topP;
  if (settings.maxTokens !== undefined) config.maxOutputTokens = settings.maxTokens;
  if (settings.stop && settings.stop.length) config.stopSequences = settings.stop;

  // Reasoning/thinking budget
  const budget = settings.reasoning?.budget ?? settings.reasoningBudget;
  if (budget !== undefined) {
    config.thinkingConfig = { thinkingBudget: budget };
  }

  return config;
}

