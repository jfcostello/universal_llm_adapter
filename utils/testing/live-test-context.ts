import { AsyncLocalStorage } from 'async_hooks';

export interface LiveTestContext {
  correlationId?: string;
  testFile?: string;
  testName?: string;
}

const storage = new AsyncLocalStorage<LiveTestContext>();

export function runWithLiveTestContext<T>(
  context: LiveTestContext,
  fn: () => Promise<T> | T
): Promise<T> | T {
  if (process.env.LLM_LIVE !== '1') {
    return fn();
  }

  return storage.run(context, fn);
}

export function getLiveTestContext(): LiveTestContext | undefined {
  if (process.env.LLM_LIVE !== '1') {
    return undefined;
  }
  return storage.getStore();
}

