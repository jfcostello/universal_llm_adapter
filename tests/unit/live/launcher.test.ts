import { jest } from '@jest/globals';

describe('tests/live/launcher', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test('parseLaunchConfig hard-fails on MAX_WORKERS env', async () => {
    process.env.MAX_WORKERS = '2';
    const { parseLaunchConfig } = await import('@tests/live/launcher/index.js');
    expect(() => parseLaunchConfig([], process.env, { maxWorkersDefault: '100%' })).toThrow(/MAX_WORKERS/i);
  });

  test('parseLaunchConfig hard-fails on --maxWorkers CLI flag', async () => {
    const { parseLaunchConfig } = await import('@tests/live/launcher/index.js');
    expect(() => parseLaunchConfig(['--maxWorkers=2'], {}, { maxWorkersDefault: '100%' })).toThrow(/--maxWorkers/i);
  });

  test('parseLaunchConfig hard-fails on -w (alias for --maxWorkers)', async () => {
    const { parseLaunchConfig } = await import('@tests/live/launcher/index.js');
    expect(() => parseLaunchConfig(['-w', '2'], {}, { maxWorkersDefault: '100%' })).toThrow(/-w/i);
  });

  test('parseLaunchConfig hard-fails on -w=<n> (alias for --maxWorkers)', async () => {
    const { parseLaunchConfig } = await import('@tests/live/launcher/index.js');
    expect(() => parseLaunchConfig(['-w=2'], {}, { maxWorkersDefault: '100%' })).toThrow(/-w/i);
  });

  test('parseLaunchConfig hard-fails on --runInBand (no concurrency caps)', async () => {
    const { parseLaunchConfig } = await import('@tests/live/launcher/index.js');
    expect(() => parseLaunchConfig(['--runInBand'], {}, { maxWorkersDefault: '100%' })).toThrow(/runInBand/i);
  });

  test('parseLaunchConfig hard-fails on -i (alias for --runInBand)', async () => {
    const { parseLaunchConfig } = await import('@tests/live/launcher/index.js');
    expect(() => parseLaunchConfig(['-i'], {}, { maxWorkersDefault: '100%' })).toThrow(/-i/i);
  });

  test('parseLaunchConfig hard-fails on --maxWorkers passed through to jest', async () => {
    const { parseLaunchConfig } = await import('@tests/live/launcher/index.js');
    expect(() => parseLaunchConfig(['--', '--maxWorkers=2'], {}, { maxWorkersDefault: '100%' })).toThrow(/--maxWorkers/i);
  });

  test('parseLaunchConfig hard-fails on --runInBand passed through to jest', async () => {
    const { parseLaunchConfig } = await import('@tests/live/launcher/index.js');
    expect(() => parseLaunchConfig(['--', '--runInBand'], {}, { maxWorkersDefault: '100%' })).toThrow(/runInBand/i);
  });

  test('parseLaunchConfig uses defaults maxWorkersDefault only', async () => {
    const { parseLaunchConfig } = await import('@tests/live/launcher/index.js');

    const cfg = parseLaunchConfig(['openrouter', '--transport=server', '--testPathPattern=x'], {}, { maxWorkersDefault: '100%' });
    expect(cfg.provider).toBe('openrouter');
    expect(cfg.transport).toBe('server');
    expect(cfg.maxWorkers).toBe('100%');
    expect(cfg.passthrough).toEqual(['--testPathPattern=x']);
  });
});
