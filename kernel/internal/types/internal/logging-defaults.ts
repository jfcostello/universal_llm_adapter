export type PrettyFileLogsMode = 'sync' | 'async' | 'off';

export interface PrettyFileLogsDefaults {
  mode: PrettyFileLogsMode;
}

export interface LLMStreamLoggingDefaults {
  chunkInfoLogsEnabled: boolean;
}

/**
 * Logging defaults (provider-agnostic).
 */
export interface LoggingDefaults {
  prettyFileLogs: PrettyFileLogsDefaults;
  llmStream: LLMStreamLoggingDefaults;
}

