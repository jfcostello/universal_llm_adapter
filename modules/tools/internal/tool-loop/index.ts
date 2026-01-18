import type { LLMResponse, LLMStreamEvent } from '../../../../kernel/index.js';

import { runNonStreamToolLoop } from './internal/run-nonstream.js';
import { runStreamToolLoop } from './internal/run-stream.js';
import type { NonStreamToolLoopOptions, StreamLoopResult, StreamToolLoopOptions } from './internal/types.js';

export function runToolLoop(options: NonStreamToolLoopOptions): Promise<LLMResponse>;
export function runToolLoop(options: StreamToolLoopOptions): AsyncGenerator<LLMStreamEvent, StreamLoopResult | undefined>;
export function runToolLoop(
  options: NonStreamToolLoopOptions | StreamToolLoopOptions
): Promise<LLMResponse> | AsyncGenerator<LLMStreamEvent, StreamLoopResult | undefined> {
  if (options.mode === 'nonstream') {
    return runNonStreamToolLoop(options);
  }
  return runStreamToolLoop(options);
}

export { __toolLoopTestUtils__ } from './internal/utils.js';
