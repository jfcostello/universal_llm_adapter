import { jest } from '@jest/globals';
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { ROOT_DIR, resolveFixture } from '@tests/helpers/paths.ts';
import { createServer } from '@/modules/server/index.ts';
import { canBindToLocalhost, postJson } from '@tests/integration/utils/server/test-helpers.ts';

let networkAvailable = true;

beforeAll(async () => {
  networkAvailable = await canBindToLocalhost();
});

describe('signals report (integration) CLI parity', () => {
  const pluginsDir = resolveFixture('plugins', 'basic');

  test('llm-adapter signals report accepts valid payload', async () => {
    const result = await runCoordinator({
      args: [
        'signals',
        'report',
        '--trace-id',
        'trace-1',
        '--generation-id',
        'gen-1',
        '--level',
        'error',
        '--message',
        'boom',
        '--plugins',
        pluginsDir
      ],
      cwd: ROOT_DIR
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.queued).toBe(false);
    expect(parsed.reason).toBe('disabled');
    expect(parsed.results).toEqual([]);
  });

  test('llm-adapter signals report rejects invalid payload', async () => {
    const result = await runCoordinator({
      args: [
        'signals',
        'report',
        '--generation-id',
        'gen-1',
        '--level',
        'error',
        '--message',
        'boom',
        '--plugins',
        pluginsDir
      ],
      cwd: ROOT_DIR
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('error');
  });
});

describe('signals report (integration) server parity', () => {
  test('POST /signals/report accepts valid payload', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      registry: { loadAll: jest.fn() } as any,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn(),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await postJson(server.url, '/signals/report', {
      traceId: 'trace-1',
      generationId: 'gen-1',
      level: 'error',
      message: 'boom',
      timestampMs: Date.now()
    });

    await server.close();

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.type).toBe('response');
    expect(parsed.data.queued).toBe(false);
    expect(parsed.data.reason).toBe('disabled');
    expect(parsed.data.results).toEqual([]);
  });

  test('POST /signals/report rejects invalid payload', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      registry: { loadAll: jest.fn() } as any,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn(),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await postJson(server.url, '/signals/report', {
      generationId: 'gen-1',
      level: 'error',
      message: 'boom',
      timestampMs: Date.now()
    });

    await server.close();

    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.type).toBe('error');
  });
});

