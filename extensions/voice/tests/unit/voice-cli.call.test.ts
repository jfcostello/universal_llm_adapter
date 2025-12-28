import http from 'http';
import { Readable, Writable } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { jest } from '@jest/globals';

import { runVoiceCli } from '../../internal/cli.js';

function createCaptureStream() {
  let data = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      data += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
      cb();
    }
  });
  return { stream, get data() { return data; } };
}

async function startServer(handler: (req: http.IncomingMessage, body: any) => { status: number; body: any }) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf-8');
    for await (const chunk of req) raw += chunk;
    const parsed = raw ? JSON.parse(raw) : undefined;

    const out = handler(req, parsed);
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

describe('extensions/voice CLI', () => {
  test('call: sends request with system prompt from --system-prompt and realtime spec from --realtime-spec', async () => {
    const expectedResponse = { callConfigId: 'cfg', providerCallId: 'call', status: 'queued' };

    const server = await startServer((req, body) => {
      expect(req.url).toBe('/voice/calls');
      expect(req.method).toBe('POST');

      expect(req.headers['content-type']).toContain('application/json');
      expect(req.headers['x-api-key']).toBe('k');
      expect(req.headers['idempotency-key']).toBe('idem');

      expect(body).toEqual({
        to: '+15550000000',
        from: '+15551111111',
        voiceProvider: 'vp',
        realtimeSpec: { transport: { type: 'ws' } },
        systemPrompt: 'hello',
        ttlSeconds: 900
      });

      return { status: 200, body: expectedResponse };
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: [
          'node',
          'llm-adapter',
          'call',
          '--server-url',
          server.baseUrl,
          '--api-key',
          'k',
          '--idempotency-key',
          'idem',
          '--to',
          '+15550000000',
          '--from',
          '+15551111111',
          '--voice-provider',
          'vp',
          '--realtime-spec',
          '{"transport":{"type":"ws"}}',
          '--system-prompt',
          'hello'
        ],
        deps: { log: jest.fn(), error: jest.fn(), exit },
        io: {
          stdin: Readable.from([]),
          stdout: stdout.stream,
          stderr: stderr.stream
        }
      });
    } finally {
      await server.close();
    }

    expect(exit).toHaveBeenCalledWith(0);
    expect(JSON.parse(stdout.data)).toEqual(expectedResponse);
    expect(stderr.data).toBe('');
  });

  test('call: supports --system-prompt-file and --realtime-spec-file and pretty output', async () => {
    const expectedResponse = { callConfigId: 'cfg2', providerCallId: 'call2', status: 'queued' };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cli-'));
    const promptPath = path.join(tmpDir, 'prompt.txt');
    const specPath = path.join(tmpDir, 'spec.json');
    fs.writeFileSync(promptPath, 'file prompt\n', 'utf-8');
    fs.writeFileSync(specPath, JSON.stringify({ transport: { type: 'ws' } }), 'utf-8');

    const server = await startServer((_req, body) => {
      expect(body.systemPrompt).toBe('file prompt\n');
      expect(body.realtimeSpec).toEqual({ transport: { type: 'ws' } });
      expect(body.ttlSeconds).toBe(123);
      return { status: 200, body: expectedResponse };
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: [
          'node',
          'llm-adapter',
          'call',
          '--server-url',
          server.baseUrl,
          '--to',
          '+15550000000',
          '--from',
          '+15551111111',
          '--voice-provider',
          'vp',
          '--system-prompt-file',
          promptPath,
          '--realtime-spec-file',
          specPath,
          '--ttl-seconds',
          '123',
          '--pretty'
        ],
        deps: { log: jest.fn(), error: jest.fn(), exit },
        io: {
          stdin: Readable.from([]),
          stdout: stdout.stream,
          stderr: stderr.stream
        }
      });
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    expect(exit).toHaveBeenCalledWith(0);
    expect(JSON.parse(stdout.data)).toEqual(expectedResponse);
    expect(stdout.data).toContain('\n');
    expect(stderr.data).toBe('');
  });

  test('call: reads system prompt from stdin when not TTY', async () => {
    const server = await startServer((_req, body) => {
      expect(body.systemPrompt).toBe('stdin prompt\n');
      return { status: 200, body: { ok: true } };
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: [
          'node',
          'llm-adapter',
          'call',
          '--server-url',
          server.baseUrl,
          '--to',
          '+15550000000',
          '--from',
          '+15551111111',
          '--voice-provider',
          'vp',
          '--realtime-spec',
          '{"transport":{"type":"ws"}}'
        ],
        deps: { log: jest.fn(), error: jest.fn(), exit },
        io: {
          stdin: Readable.from(['stdin prompt\n']),
          stdout: stdout.stream,
          stderr: stderr.stream
        }
      });
    } finally {
      await server.close();
    }

    expect(exit).toHaveBeenCalledWith(0);
    expect(JSON.parse(stdout.data)).toEqual({ ok: true });
  });

  test('call: does not read stdin when TTY and no system prompt is provided', async () => {
    const server = await startServer((_req, body) => {
      expect(body.systemPrompt).toBeUndefined();
      return { status: 200, body: { ok: true } };
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    const stdin = Readable.from(['ignored']);
    (stdin as any).isTTY = true;

    try {
      await runVoiceCli({
        argv: [
          'node',
          'llm-adapter',
          'call',
          '--server-url',
          server.baseUrl,
          '--to',
          '+15550000000',
          '--from',
          '+15551111111',
          '--voice-provider',
          'vp',
          '--realtime-spec',
          '{"transport":{"type":"ws"}}'
        ],
        deps: { log: jest.fn(), error: jest.fn(), exit },
        io: {
          stdin,
          stdout: stdout.stream,
          stderr: stderr.stream
        }
      });
    } finally {
      await server.close();
    }

    expect(exit).toHaveBeenCalledWith(0);
    expect(JSON.parse(stdout.data)).toEqual({ ok: true });
  });

  test('call: writes server error response to stderr and exits 1', async () => {
    const server = await startServer(() => ({
      status: 401,
      body: { type: 'error', error: { message: 'Unauthorized', code: 'unauthorized' } }
    }));

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: [
          'node',
          'llm-adapter',
          'call',
          '--server-url',
          server.baseUrl,
          '--to',
          '+15550000000',
          '--from',
          '+15551111111',
          '--voice-provider',
          'vp',
          '--realtime-spec',
          '{"transport":{"type":"ws"}}'
        ],
        deps: { log: jest.fn(), error: jest.fn(), exit },
        io: {
          stdin: Readable.from([]),
          stdout: stdout.stream,
          stderr: stderr.stream
        }
      });
    } finally {
      await server.close();
    }

    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout.data).toBe('');
    expect(stderr.data).toContain('unauthorized');
  });

  test('call: exits 1 with invalid realtime spec JSON', async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const error = jest.fn((msg: string) => stderr.stream.write(msg + '\n'));
    const exit = jest.fn();

    await runVoiceCli({
      argv: [
        'node',
        'llm-adapter',
        'call',
        '--server-url',
        'http://127.0.0.1:1234',
        '--to',
        '+15550000000',
        '--from',
        '+15551111111',
        '--voice-provider',
        'vp',
        '--realtime-spec',
        '{not-json'
      ],
      deps: { log: jest.fn(), error, exit },
      io: {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.data).toContain('invalid_json');
  });

  test('call: exits 1 when missing required fields', async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const error = jest.fn((msg: string) => stderr.stream.write(msg + '\n'));
    const exit = jest.fn();

    await runVoiceCli({
      argv: [
        'node',
        'llm-adapter',
        'call',
        '--server-url',
        'http://127.0.0.1:1234',
        '--from',
        '+15551111111',
        '--voice-provider',
        'vp',
        '--realtime-spec',
        '{"transport":{"type":"ws"}}'
      ],
      deps: { error, exit },
      io: {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.data).toContain('validation_error');
    expect(stderr.data).toContain('Missing to');
  });

  test('call: exits 1 when realtime spec is missing', async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const error = jest.fn((msg: string) => stderr.stream.write(msg + '\n'));
    const exit = jest.fn();

    await runVoiceCli({
      argv: [
        'node',
        'llm-adapter',
        'call',
        '--server-url',
        'http://127.0.0.1:1234',
        '--to',
        '+15550000000',
        '--from',
        '+15551111111',
        '--voice-provider',
        'vp'
      ],
      deps: { error, exit },
      io: {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.data).toContain('validation_error');
    expect(stderr.data).toContain('Missing realtimeSpec');
  });

  test('call: invalid --ttl-seconds falls back to default TTL', async () => {
    const server = await startServer((_req, body) => {
      expect(body.ttlSeconds).toBe(900);
      return { status: 200, body: { ok: true } };
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: [
          'node',
          'llm-adapter',
          'call',
          '--server-url',
          server.baseUrl,
          '--to',
          '+15550000000',
          '--from',
          '+15551111111',
          '--voice-provider',
          'vp',
          '--realtime-spec',
          '{"transport":{"type":"ws"}}',
          '--ttl-seconds',
          'not-a-number'
        ],
        deps: { error: jest.fn(), exit },
        io: {
          stdin: Readable.from([]),
          stdout: stdout.stream,
          stderr: stderr.stream
        }
      });
    } finally {
      await server.close();
    }

    expect(exit).toHaveBeenCalledWith(0);
    expect(JSON.parse(stdout.data)).toEqual({ ok: true });
    expect(stderr.data).toBe('');
  });

  test('uses default deps/io when not provided and exits 1 on parse errors', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runVoiceCli({
        argv: ['node', 'llm-adapter', 'unknown'],
        deps: {}
      } as any);

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });
});
