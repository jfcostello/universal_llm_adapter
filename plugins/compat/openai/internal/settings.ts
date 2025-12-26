import type { LLMCallSettings } from '../../../../kernel/index.js';

export function serializeSettings(settings: LLMCallSettings): any {
  const result: any = {};

  if (settings.temperature !== undefined) {
    result.temperature = settings.temperature;
  }
  if (settings.topP !== undefined) {
    result.top_p = settings.topP;
  }
  if (settings.maxTokens !== undefined) {
    result.max_tokens = settings.maxTokens;
  }
  if (settings.stop) {
    result.stop = settings.stop;
  }
  if (settings.responseFormat) {
    result.response_format = { type: settings.responseFormat };
  }
  if (settings.seed !== undefined) {
    result.seed = settings.seed;
  }
  if (settings.frequencyPenalty !== undefined) {
    result.frequency_penalty = settings.frequencyPenalty;
  }
  if (settings.presencePenalty !== undefined) {
    result.presence_penalty = settings.presencePenalty;
  }
  if (settings.logitBias !== undefined) {
    result.logit_bias = settings.logitBias;
  }
  if (settings.logprobs !== undefined) {
    result.logprobs = settings.logprobs;
  }
  if (settings.topLogprobs !== undefined) {
    result.top_logprobs = settings.topLogprobs;
  }

  // Serialize reasoning settings for OpenAI-compatible providers.
  if (settings.reasoning) {
    const reasoningPayload: any = {};

    if (settings.reasoning.enabled !== undefined) {
      reasoningPayload.enabled = settings.reasoning.enabled;
    }

    // effort and max_tokens are mutually exclusive - effort takes precedence
    if (settings.reasoning.effort) {
      reasoningPayload.effort = settings.reasoning.effort;
    } else if (settings.reasoning.budget || settings.reasoningBudget) {
      reasoningPayload.max_tokens = settings.reasoning.budget || settings.reasoningBudget;
    }

    if (settings.reasoning.exclude !== undefined) {
      reasoningPayload.exclude = settings.reasoning.exclude;
    }

    if (Object.keys(reasoningPayload).length > 0) {
      result.reasoning = reasoningPayload;
    }
  }

  return result;
}

