import { jest } from '@jest/globals';
import http from 'http';

import voiceExtension from '../../index.ts';
import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';

describe('extensions/voice', () => {
  test('exports a stable extension object', async () => {
    expect(voiceExtension.name).toBe('voice');
    expect(typeof (voiceExtension as any).registerServer).toBe('function');
  });

  test('registerServer returns a handler that only intercepts /voice/*', async () => {
    const server = http.createServer();
    const upgradeRouter = attachUpgradeRouter(server);

    const reg = await (voiceExtension as any).registerServer({
      server,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter
    });

    const resA: any = { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    await expect(reg.handleHttp({ url: '/health' } as any, resA)).resolves.toBe(false);
    expect(resA.writeHead).not.toHaveBeenCalled();
    expect(resA.end).not.toHaveBeenCalled();

    const resB: any = { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    await expect(reg.handleHttp({ url: undefined } as any, resB)).resolves.toBe(false);
    expect(resB.writeHead).not.toHaveBeenCalled();
    expect(resB.end).not.toHaveBeenCalled();

    const resC: any = { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    await expect(reg.handleHttp({ url: '/voice' } as any, resC)).resolves.toBe(true);
    expect(String(resC.writeHead.mock.calls[0][0])).toBe('200');
    expect(resC.end).toHaveBeenCalled();

    const resD: any = { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    await expect(reg.handleHttp({ url: '/voice/webhook' } as any, resD)).resolves.toBe(true);
    expect(String(resD.writeHead.mock.calls[0][0])).toBe('400');
    expect(resD.end).toHaveBeenCalled();

    const resE: any = { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    await expect(reg.handleHttp({ url: 'http://%' } as any, resE)).resolves.toBe(false);
    expect(resE.writeHead).not.toHaveBeenCalled();
    expect(resE.end).not.toHaveBeenCalled();
    upgradeRouter.close();
  });
});
