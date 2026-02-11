import fs from 'fs';

import { getDefaults, type PrettyFileLogsMode } from '../../../kernel/index.js';

import { createBufferedAppendState, scheduleFlush, startFlush } from './buffered-append.js';

export type PrettyFileAppender = {
  append: (text: string) => void;
  flush: () => Promise<void>;
};

function parsePrettyFileLogsMode(value: unknown): PrettyFileLogsMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sync' || normalized === 'async' || normalized === 'off') {
    return normalized;
  }
  return undefined;
}

export function resolvePrettyFileLogsMode(): PrettyFileLogsMode {
  const envMode = parsePrettyFileLogsMode(process.env.LLM_ADAPTER_LOG_PRETTY_FILE_MODE);
  if (envMode) return envMode;

  const defaults = getDefaults() as any;
  const defaultsMode = parsePrettyFileLogsMode(defaults?.logging?.prettyFileLogs?.mode);
  return defaultsMode ?? 'sync';
}

export function createPrettyFileAppender(options: {
  filePath: string;
  mode: PrettyFileLogsMode;
}): PrettyFileAppender {
  if (options.mode === 'off') {
    return {
      append: () => {},
      flush: async () => {}
    };
  }

  if (options.mode === 'sync') {
    return {
      append: (text) => {
        fs.appendFileSync(options.filePath, text);
      },
      flush: async () => {}
    };
  }

  const state = createBufferedAppendState();
  const flush = async () =>
    await startFlush(state, async (batch) => {
      await fs.promises.appendFile(options.filePath, batch);
    });

  return {
    append: (text) => {
      state.pendingWrites.push(text);
      scheduleFlush(state, flush);
    },
    flush
  };
}
