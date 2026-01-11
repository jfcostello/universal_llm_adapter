import { readEnvFloat, readEnvInt } from '../../../modules/logging/index.js';

const DEFAULT_MAX_FILES = readEnvInt('LLM_ADAPTER_LOG_MAX_FILES', 50);
const DEFAULT_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_LOG_MAX_AGE_DAYS');

export const VOICE_MAX_FILES = readEnvInt('LLM_ADAPTER_VOICE_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const VOICE_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_VOICE_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);
export const VOICE_MAX_BYTES = readEnvInt('LLM_ADAPTER_VOICE_LOG_MAX_BYTES', 0);

