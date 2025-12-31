import { jest } from '@jest/globals';
import http from 'http';
import { Readable, Writable } from 'stream';

import voiceExtension from '../../index.ts';
import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';
import { closeServerAndSockets, trackServerSockets, unrefServer } from '../helpers/http-server.ts';

describe('extensions/voice', () => {
  test('exports a stable extension object', async () => {
    expect(voiceExtension.name).toBe('voice');
    expect(typeof (voiceExtension as any).registerServer).toBe('function');
  });

  test('runCli delegates to the voice CLI runner', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const sockets = trackServerSockets(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    unrefServer(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected server address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    let stdout = '';
    let stderr = '';
    const exitCodes: number[] = [];

    const stdin = Readable.from([]);
    (stdin as any).isTTY = true;

    const stdoutStream = new Writable({
      write(chunk, _enc, cb) {
        stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
        cb();
      }
    });

    const stderrStream = new Writable({
      write(chunk, _enc, cb) {
        stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
        cb();
      }
    });

    try {
      await (voiceExtension as any).runCli({
        argv: [
          'node',
          'llm-adapter',
          'call',
          '--server-url',
          baseUrl,
          '--to',
          '+15550000000',
          '--from',
          '+15551111111',
          '--voice-provider',
          'vp',
          '--realtime-spec',
          '{"transport":{"type":"ws"}}'
        ],
        deps: {
          error: (msg: string) => { stderr += msg; },
          exit: (code: number) => exitCodes.push(code)
        },
        io: {
          stdin,
          stdout: stdoutStream,
          stderr: stderrStream
        }
      });
    } finally {
      await closeServerAndSockets(server, sockets);
    }

    expect(exitCodes).toEqual([0]);
    expect(stdout).toContain('ok');
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
