export interface LLMCallSettings {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: string;
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  logitBias?: Record<number, number>;
  logprobs?: boolean;
  topLogprobs?: number;
  reasoning?: {
    enabled?: boolean;
    effort?: 'high' | 'medium' | 'low' | 'minimal' | 'none' | 'xhigh';
    budget?: number;
    exclude?: boolean;
  };
  reasoningBudget?: number;
  toolCountdownEnabled?: boolean;
  toolFinalPromptEnabled?: boolean;
  maxToolIterations?: number;
  preserveToolResults?: number | 'all' | 'none';
  preserveReasoning?: number | 'all' | 'none';
  parallelToolExecution?: boolean;
  toolResultMaxChars?: number;
  batchId?: string;
  /** Enable optional usage cost calculation when provider omits cost */
  usageCost?: boolean;
  assistantId?: string;
  provider?: Record<string, any>;
  [key: string]: any;
}

export const RUNTIME_SETTING_KEYS = [
  'toolCountdownEnabled',
  'toolFinalPromptEnabled',
  'maxToolIterations',
  'preserveToolResults',
  'preserveReasoning',
  'parallelToolExecution',
  'toolResultMaxChars',
  'batchId'
] as const;

export type RuntimeSettingKey = typeof RUNTIME_SETTING_KEYS[number];
export type RuntimeSettings = Pick<LLMCallSettings, RuntimeSettingKey>;

export const PROVIDER_SETTING_KEYS = [
  'temperature',
  'topP',
  'maxTokens',
  'stop',
  'responseFormat',
  'seed',
  'frequencyPenalty',
  'presencePenalty',
  'logitBias',
  'logprobs',
  'topLogprobs',
  'reasoning',
  'reasoningBudget',
  'usageCost',
  'assistantId'
] as const;

export interface LLMPriorityItem {
  provider: string;
  model: string;
  /** Optional per-entry overrides (including provider extras) that override global settings via deep merge */
  settings?: Partial<LLMCallSettings>;
}
