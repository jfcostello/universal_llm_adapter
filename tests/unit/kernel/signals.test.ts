import { describe, expect, test } from '@jest/globals';

describe('kernel/signals', () => {
  test('getNoopSignalsDeps caches exporter and resets on shutdown', async () => {
    const { getNoopSignalsDeps } = await import('@/kernel/index.ts');

    const deps = getNoopSignalsDeps();
    expect(deps.isEnabled()).toBe(false);

    const exporter1 = deps.getExporter();
    const res1 = exporter1.recordSignal({
      traceId: 't',
      generationId: 'g',
      timestampMs: 0,
      level: 'error',
      message: 'boom'
    });
    expect(res1.queued).toBe(false);
    expect(res1.reason).toBe('disabled');
    expect(res1.results).toEqual([]);
    await exporter1.flush();

    const exporter2 = deps.getExporter();
    expect(exporter2).toBe(exporter1);

    await deps.shutdown();

    const exporter3 = deps.getExporter();
    expect(exporter3).not.toBe(exporter1);
  });

  test('resolveSignalsDeps uses defaults and overrides', async () => {
    const { resolveSignalsDeps, getNoopSignalsDeps } = await import('@/kernel/index.ts');

    // Default arg branch
    const resolvedDefault = resolveSignalsDeps();
    expect(resolvedDefault.isEnabled()).toBe(false);
    expect(resolvedDefault.getExporter()).toBe(getNoopSignalsDeps().getExporter());

    const exporter = {
      recordSignal: () => ({ queued: true, results: [] }),
      flush: async () => {}
    };

    const overrides = {
      isEnabled: () => true,
      getExporter: () => exporter,
      shutdown: async () => {}
    };

    const resolvedOverrides = resolveSignalsDeps(overrides as any);
    expect(resolvedOverrides.isEnabled()).toBe(true);
    expect(resolvedOverrides.getExporter()).toBe(exporter);
    await expect(resolvedOverrides.shutdown()).resolves.toBeUndefined();
  });
});
