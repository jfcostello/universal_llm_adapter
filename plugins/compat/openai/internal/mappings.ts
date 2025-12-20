import type { UsageExtractionSpec } from '../../../../modules/usage/index.js';

export const OPENAI_USAGE_SPEC: UsageExtractionSpec = {
  reasoningTokens: [
    ['usage', 'completion_tokens_details', 'reasoning_tokens'],
    ['completion_tokens_details', 'reasoning_tokens']
  ],
  cachedTokens: [
    ['usage', 'prompt_tokens_details', 'cached_tokens'],
    ['prompt_tokens_details', 'cached_tokens']
  ],
  audioTokens: [
    ['usage', 'prompt_tokens_details', 'audio_tokens'],
    ['prompt_tokens_details', 'audio_tokens']
  ]
};
