export type BufferedAppendState = {
  pendingWrites: any;
  flushScheduled: boolean;
  flushAgain: boolean;
  flushPromise: Promise<void> | null;
};

export function createBufferedAppendState(): BufferedAppendState {
  return {
    pendingWrites: [],
    flushScheduled: false,
    flushAgain: false,
    flushPromise: null
  };
}

export function scheduleFlush(
  state: BufferedAppendState,
  flush: () => Promise<void> | void
): void {
  if (state.flushPromise) {
    state.flushAgain = true;
    return;
  }
  if (state.flushScheduled) return;
  state.flushScheduled = true;
  setImmediate(() => {
    state.flushScheduled = false;
    try {
      const result = flush();
      if (result && typeof (result as any).catch === 'function') {
        void (result as any).catch(() => {});
      }
    } catch {
      // best-effort
    }
  });
}

export function startFlush(
  state: BufferedAppendState,
  writeBatch: (batch: string) => Promise<void>
): Promise<void> {
  if (state.flushPromise) {
    state.flushAgain = true;
    return state.flushPromise;
  }

  state.flushPromise = (async () => {
    while (true) {
      const next = state.pendingWrites.splice(0, state.pendingWrites.length);
      if (next.length === 0) {
        if (state.flushAgain) {
          state.flushAgain = false;
          continue;
        }
        break;
      }

      try {
        await writeBatch(next.join(''));
      } catch {
        // Best-effort: drop pending lines on write failure.
      }
    }
  })()
    .catch(() => {})
    .finally(() => {
      state.flushPromise = null;
    });

  return state.flushPromise;
}

