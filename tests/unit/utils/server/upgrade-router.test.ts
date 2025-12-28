import http from 'http';
import { jest } from '@jest/globals';

import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';

describe('server/internal/transport/upgrade-router', () => {
  test('dispatches to the first handler that returns true', async () => {
    const server = http.createServer();
    const router = attachUpgradeRouter(server);

    const first = jest.fn().mockResolvedValue(false);
    const second = jest.fn().mockResolvedValue(true);
    const third = jest.fn().mockResolvedValue(true);

    router.register(first);
    router.register(second);
    router.register(third);

    const socket: any = { write: jest.fn(), destroy: jest.fn() };
    server.emit('upgrade', { url: '/x' } as any, socket as any, Buffer.alloc(0));
    await new Promise(res => setTimeout(res, 0));

    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();

    router.close();
  });

  test('writes a 404 when no handler handles the request (and exercises parseWsPath branches)', async () => {
    const server = http.createServer();
    const router = attachUpgradeRouter(server);

    const socketA: any = { write: jest.fn(), destroy: jest.fn() };
    server.emit('upgrade', { url: '/nope' } as any, socketA as any, Buffer.alloc(0));
    await new Promise(res => setTimeout(res, 0));
    expect(String(socketA.write.mock.calls[0][0])).toContain('404 Not Found');
    expect(socketA.destroy).toHaveBeenCalled();

    const socketB: any = { write: jest.fn(), destroy: jest.fn() };
    server.emit('upgrade', { url: undefined } as any, socketB as any, Buffer.alloc(0));
    await new Promise(res => setTimeout(res, 0));
    expect(String(socketB.write.mock.calls[0][0])).toContain('404 Not Found');
    expect(socketB.destroy).toHaveBeenCalled();

    const socketC: any = { write: jest.fn(), destroy: jest.fn() };
    server.emit('upgrade', { url: '' } as any, socketC as any, Buffer.alloc(0));
    await new Promise(res => setTimeout(res, 0));
    expect(String(socketC.write.mock.calls[0][0])).toContain('404 Not Found');
    expect(socketC.destroy).toHaveBeenCalled();

    const socketD: any = { write: jest.fn(), destroy: jest.fn() };
    server.emit('upgrade', { url: 'http://%' } as any, socketD as any, Buffer.alloc(0));
    await new Promise(res => setTimeout(res, 0));
    expect(String(socketD.write.mock.calls[0][0])).toContain('404 Not Found');
    expect(socketD.destroy).toHaveBeenCalled();

    router.close();
  });

  test('writes a 500 when a handler throws', async () => {
    const server = http.createServer();
    const router = attachUpgradeRouter(server);

    router.register(() => {
      throw new Error('boom');
    });

    const socket: any = { write: jest.fn(), destroy: jest.fn() };
    server.emit('upgrade', { url: '/x' } as any, socket as any, Buffer.alloc(0));
    await new Promise(res => setTimeout(res, 0));

    expect(String(socket.write.mock.calls[0][0])).toContain('500 Internal Server Error');
    expect(socket.destroy).toHaveBeenCalled();

    router.close();
  });
});

