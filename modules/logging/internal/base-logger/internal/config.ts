import * as path from 'path';

import { readEnvFloat, readEnvInt } from '../../retention.js';

export const disableFileLogs = process.env.LLM_ADAPTER_DISABLE_FILE_LOGS === '1';
export const disableConsoleLogs = process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS === '1';

export const logDir = path.join(process.cwd(), 'logs');
export const llmLogDir = path.join(logDir, 'llm');
export const embeddingLogDir = path.join(logDir, 'embedding');
export const vectorLogDir = path.join(logDir, 'vector');
export const realtimeLogDir = path.join(logDir, 'realtime');

const DEFAULT_MAX_FILES = readEnvInt('LLM_ADAPTER_LOG_MAX_FILES', 50);
const DEFAULT_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_LOG_MAX_AGE_DAYS');

export const LLM_MAX_FILES = readEnvInt('LLM_ADAPTER_LLM_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const LLM_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_LLM_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);

export const ADAPTER_MAX_FILES = readEnvInt('LLM_ADAPTER_ADAPTER_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const ADAPTER_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_ADAPTER_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);
export const ADAPTER_BATCH_MAX_FILES = readEnvInt('LLM_ADAPTER_BATCH_LOG_MAX_FILES', ADAPTER_MAX_FILES);

export const EMBEDDING_MAX_FILES = readEnvInt('LLM_ADAPTER_EMBEDDING_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const EMBEDDING_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_EMBEDDING_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);

export const VECTOR_MAX_FILES = readEnvInt('LLM_ADAPTER_VECTOR_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const VECTOR_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_VECTOR_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);

export const REALTIME_MAX_FILES = readEnvInt('LLM_ADAPTER_REALTIME_LOG_MAX_FILES', DEFAULT_MAX_FILES);
export const REALTIME_MAX_AGE_DAYS = readEnvFloat('LLM_ADAPTER_REALTIME_LOG_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS);
export const REALTIME_MAX_BYTES = readEnvInt('LLM_ADAPTER_REALTIME_LOG_MAX_BYTES', 0);

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
}

export function getBatchEnv(): { batchId?: string; useBatchDir: boolean } {
  const raw = process.env.LLM_ADAPTER_BATCH_ID;
  const batchId = raw ? sanitizeId(raw) : undefined;
  const useDir = process.env.LLM_ADAPTER_BATCH_DIR === '1';
  return { batchId, useBatchDir: useDir };
}

export function createIsoTimestamp(): string {
  return new Date().toISOString();
}

export function createIsoFilenameStamp(): string {
  return createIsoTimestamp().replace(/[:.]/g, '-');
}

