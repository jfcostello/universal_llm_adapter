import type { UsageExtractionSpec } from '../../../../modules/usage/index.js';

export const OPENAI_USAGE_SPEC_RESPONSE: UsageExtractionSpec = {
  promptTokens: ['usage', 'prompt_tokens'],
  completionTokens: ['usage', 'completion_tokens'],
  totalTokens: ['usage', 'total_tokens'],
  reasoningTokens: ['usage', 'completion_tokens_details', 'reasoning_tokens'],
  cost: ['usage', 'cost'],
  cachedTokens: ['usage', 'prompt_tokens_details', 'cached_tokens'],
  audioTokens: ['usage', 'prompt_tokens_details', 'audio_tokens']
};

export const OPENAI_USAGE_SPEC_STREAM: UsageExtractionSpec = {
  promptTokens: [['prompt_tokens'], ['promptTokens']],
  completionTokens: [['completion_tokens'], ['completionTokens']],
  totalTokens: [['total_tokens'], ['totalTokens']],
  reasoningTokens: [
    ['completion_tokens_details', 'reasoning_tokens'],
    ['reasoning_tokens'],
    ['reasoningTokens']
  ],
  cost: 'cost',
  cachedTokens: [['prompt_tokens_details', 'cached_tokens'], ['cachedTokens']],
  audioTokens: [['prompt_tokens_details', 'audio_tokens'], ['audioTokens']]
};
