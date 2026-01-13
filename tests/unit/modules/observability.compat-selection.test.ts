import { createObservabilityDeps } from '@/modules/observability/index.ts';
import { jest } from '@jest/globals';

describe('modules/observability (compat selection)', () => {
  test('createObservabilityDeps prefers getObservabilityCompatForProvider when available', async () => {
    const mockCompat = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const mockManifest = {
      id: 'test',
      compat: 'test-compat',
      endpoint: { urlTemplate: 'http://test', method: 'POST' }
    };

    const registry = {
      getObservabilityProvider: jest.fn(async () => mockManifest),
      getObservabilityCompatForProvider: jest.fn(async () => mockCompat),
      getObservabilityCompat: jest.fn(async () => mockCompat)
    };

    const deps = await createObservabilityDeps(registry as any, {
      enabled: true,
      provider: 'test',
      sampleRate: 1
    } as any);

    expect(deps.isEnabled()).toBe(true);
    expect(registry.getObservabilityCompatForProvider).toHaveBeenCalledWith('test');
    expect(registry.getObservabilityCompat).not.toHaveBeenCalled();

    await deps.shutdown();
  });
});
