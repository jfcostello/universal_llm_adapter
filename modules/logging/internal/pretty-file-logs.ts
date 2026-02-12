import fs from 'fs';

import { getDefaults, type PrettyFileLogsMode } from '../../../kernel/index.js';

import { createBufferedAppendState, scheduleFlush, startFlush } from './buffered-append.js';

export type PrettyFileAppender = {
  append: (text: string) => void;
  flush: () => Promise<void>;
};

export const PRETTY_FILE_LOGS_ASYNC_MAX_PENDING_BYTES = 2 * 1024 * 1024;

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
  const maxPendingBytes = PRETTY_FILE_LOGS_ASYNC_MAX_PENDING_BYTES;

  const trimPendingWrites = (incomingBytes: number): void => {
    while (state.pendingWrites.length > 0 && state.pendingBytes + incomingBytes > maxPendingBytes) {
      const removed = state.pendingWrites.shift();
      if (typeof removed === 'string') {
        state.pendingBytes = Math.max(0, state.pendingBytes - Buffer.byteLength(removed));
      }
    }
  };

  const flush = async () =>
    await startFlush(state, async (batch) => {
      state.pendingBytes = Math.max(0, state.pendingBytes - Buffer.byteLength(batch));
      await fs.promises.appendFile(options.filePath, batch);
    });

  return {
    append: (text) => {
      const incomingBytes = Buffer.byteLength(text);
      if (incomingBytes > maxPendingBytes) {
        return;
      }

      trimPendingWrites(incomingBytes);

      state.pendingWrites.push(text);
      state.pendingBytes += incomingBytes;
      scheduleFlush(state, flush);
    },
    flush
  };
}
