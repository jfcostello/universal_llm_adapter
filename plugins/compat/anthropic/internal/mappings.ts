import type { UsageExtractionSpec } from '../../../../modules/usage/index.js';

export const ANTHROPIC_USAGE_SPEC: UsageExtractionSpec = {
  promptTokens: [['input_tokens'], ['prompt_tokens']],
  completionTokens: [['output_tokens'], ['completion_tokens']],
  reasoningTokens: [['reasoning_tokens']]
};

export const ANTHROPIC_STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  stop_sequence: 'stop'
};

