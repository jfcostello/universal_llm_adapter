import { jest } from '@jest/globals';
import { PluginRegistry } from '@/core/registry.ts';
import { AdapterLogger } from '@/core/logging.ts';
import { LLMManager } from '@/managers/llm-manager.ts';
import { LLMResponse } from '@/core/types.ts';
import { ROOT_DIR, resolveFixture } from '@tests/helpers/paths.ts';

type PartialLLMManager = Pick<LLMManager, 'callProvider' | 'streamProvider'>;

export async function loadBasicRegistry(): Promise<PluginRegistry> {
  const pluginsDir = resolveFixture('plugins', 'basic');
  const registry = new PluginRegistry(pluginsDir);
  await registry.loadAll();
  return registry;
}

export function createLoggerStub(): AdapterLogger {
  const logger = {
    info: jest.fn(),
    debug: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    logLLMRequest: jest.fn(),
    logLLMResponse: jest.fn(),
    close: jest.fn(),
    withCorrelation: jest.fn().mockReturnThis()
  } as unknown as AdapterLogger;
  return logger;
}

interface LLMManagerMockOptions {
  callResponses?: LLMResponse[] | (() => Promise<LLMResponse>);
  streamGenerator?: () => AsyncGenerator<any>;
}

export function createLLMManagerMock(options: LLMManagerMockOptions = {}): PartialLLMManager & {
  callProvider: jest.Mock;
  streamProvider: jest.Mock;
} {
  const callQueue =
    Array.isArray(options.callResponses) ? [...options.callResponses] : undefined;

  const callProvider = jest.fn<Promise<LLMResponse>, any[]>(async () => {
    if (typeof options.callResponses === 'function') {
      return options.callResponses();
    }
    if (!callQueue || callQueue.length === 0) {
      throw new Error('No mock callProvider response available');
    }
    return callQueue.shift()!;
  });

  const streamProvider = jest.fn(async function* () {
    if (options.streamGenerator) {
      for await (const chunk of options.streamGenerator()) {
        yield chunk;
      }
      return;
    }
  });

  return {
    callProvider,
    streamProvider
  };
}

export function cloneMessages<T>(messages: T[]): T[] {
  return messages.map(message => JSON.parse(JSON.stringify(message)));
}
