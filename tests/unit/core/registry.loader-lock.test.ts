import { describe, expect, jest, test } from '@jest/globals';

describe('kernel/registry loader lock', () => {
  test('dedupes concurrent loads and sets loaded flag on success', async () => {
    const { runLoaderOnce } = await import('@/kernel/internal/registry/internal/loader-lock.ts');

    const state: any = { providersLoaded: false };
    let runs = 0;

    const load = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    };

    const p1 = runLoaderOnce(state, 'providersLoaded', 'providers', load);
    const p2 = runLoaderOnce(state, 'providersLoaded', 'providers', load);

    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);

    expect(runs).toBe(1);
    expect(state.providersLoaded).toBe(true);
  });

  test('returns immediately when already loaded', async () => {
    const { runLoaderOnce } = await import('@/kernel/internal/registry/internal/loader-lock.ts');

    const state: any = { toolsLoaded: true };
    const load = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    await runLoaderOnce(state, 'toolsLoaded', 'tools', load);
    expect(load).not.toHaveBeenCalled();
  });

  test('clears in-flight lock and does not set loaded flag on failure', async () => {
    const { runLoaderOnce } = await import('@/kernel/internal/registry/internal/loader-lock.ts');

    const state: any = { mcpServersLoaded: false };

    let runs = 0;
    const load = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('boom');
    };

    const p1 = runLoaderOnce(state, 'mcpServersLoaded', 'mcp', load);
    const p2 = runLoaderOnce(state, 'mcpServersLoaded', 'mcp', load);

    expect(p1).toBe(p2);
    await expect(Promise.all([p1, p2])).rejects.toThrow('boom');

    expect(runs).toBe(1);
    expect(state.mcpServersLoaded).toBe(false);

    const p3 = runLoaderOnce(state, 'mcpServersLoaded', 'mcp', load);
    expect(p3).not.toBe(p1);
    await expect(p3).rejects.toThrow('boom');
    expect(runs).toBe(2);
  });

  test('does not dedupe different loader keys', async () => {
    const { runLoaderOnce } = await import('@/kernel/internal/registry/internal/loader-lock.ts');

    const state: any = { providersLoaded: false, toolsLoaded: false };

    let providersRuns = 0;
    let toolsRuns = 0;

    const loadProviders = async () => {
      providersRuns += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    const loadTools = async () => {
      toolsRuns += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    await Promise.all([
      runLoaderOnce(state, 'providersLoaded', 'providers', loadProviders),
      runLoaderOnce(state, 'toolsLoaded', 'tools', loadTools)
    ]);

    expect(providersRuns).toBe(1);
    expect(toolsRuns).toBe(1);
  });
});

