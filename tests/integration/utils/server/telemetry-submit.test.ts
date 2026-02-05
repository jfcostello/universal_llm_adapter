import { jest } from '@jest/globals';

import { canBindToLocalhost, postJson, startServer } from './test-helpers.ts';

let networkAvailable = true;

beforeAll(async () => {
  networkAvailable = await canBindToLocalhost();
});

function createOkCoordinator() {
  return {
    run: jest.fn().mockResolvedValue({ ok: true }),
    runStream: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined)
  };
}

describe('utils/server (integration) telemetry submit', () => {
  test('POST /telemetry accepts a signal payload', async () => {
    if (!networkAvailable) return;

    const { server } = await startServer({} as any, createOkCoordinator);
    try {
      const res = await postJson(server.url, '/telemetry', {
        type: 'signal',
        traceId: 'trace_1',
        level: 'error',
        message: 'boom'
      });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.type).toBe('response');
      expect(parsed.data.traceId).toBe('trace_1');
      expect(parsed.data.queued).toBe(false);
    } finally {
      await server.close();
    }
  });

  test('POST /telemetry rejects invalid payloads', async () => {
    if (!networkAvailable) return;

    const { server } = await startServer({} as any, createOkCoordinator);
    try {
      const res = await postJson(server.url, '/telemetry', {
        type: 'signal',
        traceId: 'trace_2',
        level: 'error'
      });

      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.type).toBe('error');
      expect(parsed.error.code).toBe('validation_error');
    } finally {
      await server.close();
    }
  });

  test('POST /telemetry accepts a trace_update payload', async () => {
    if (!networkAvailable) return;

    const { server } = await startServer({} as any, createOkCoordinator);
    try {
      const res = await postJson(server.url, '/telemetry', {
        type: 'trace_update',
        traceId: 'trace_3',
        name: 'checkout-flow',
        tags: ['web', 'prod']
      });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.type).toBe('response');
      expect(parsed.data.traceId).toBe('trace_3');
      expect(parsed.data.queued).toBe(false);
    } finally {
      await server.close();
    }
  });
});
