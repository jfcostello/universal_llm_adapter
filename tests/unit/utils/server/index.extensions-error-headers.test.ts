import http from 'http';
import { jest } from '@jest/globals';

describe('utils/server extension error handling', () => {
  test('propagates extension error headers and ignores invalid headers', async () => {
    jest.resetModules();

    const closeExtensions = jest.fn().mockResolvedValue(undefined);

    (jest as any).unstable_mockModule('../../../../modules/server/internal/extensions/host.js', () => ({
      loadServerExtensions: async () => ({
        handleHttp: async () => {
          const error: any = new Error('boom');
          error.statusCode = 418;
          error.code = 'teapot';
          error.headers = { 'x-test': '1', 'bad header': '2' };
          throw error;
        },
        close: closeExtensions
      })
    }));

    const { createServer } = await import('@/modules/server/index.ts');

    const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };
    const running = await createServer({
      registry: registry as any,
      extensions: { enabled: ['a'] },
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      } as any
    } as any);

    const response = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const url = new URL(running.url);
      const req = http.request(
        {
          method: 'GET',
          host: url.hostname,
          port: Number(url.port),
          path: '/health'
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(response.status).toBe(418);
    expect(response.headers['x-test']).toBe('1');
    expect(response.headers['bad header']).toBeUndefined();
    expect(String(response.headers['content-type'] ?? '')).toContain('application/json');

    await running.close();
    expect(closeExtensions).toHaveBeenCalledTimes(1);
  });
});

