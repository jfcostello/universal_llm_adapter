import { jest } from '@jest/globals';
import { LLMManager } from '@/modules/llm/index.ts';

describe('managers/llm-manager (compat selection)', () => {
  test('streamProvider prefers getCompatModuleForProvider when available', async () => {
    const compat = {
      streamSDK: async function* () {
        yield { ok: true };
      }
    };

    const registry = {
      getCompatModuleForProvider: jest.fn().mockResolvedValue(compat),
      getCompatModule: jest.fn()
    };

    const manager = new LLMManager(registry as any);

    const provider = {
      id: 'p',
      compat: 'foo',
      endpoint: { urlTemplate: 'sdk://local', headers: {} }
    };

    const chunks: any[] = [];
    for await (const chunk of manager.streamProvider(
      provider as any,
      'model',
      {} as any,
      [] as any,
      [] as any,
      undefined,
      {},
      undefined,
      {}
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ ok: true }]);
    expect(registry.getCompatModuleForProvider).toHaveBeenCalledWith('p');
    expect(registry.getCompatModule).not.toHaveBeenCalled();
  });
});
