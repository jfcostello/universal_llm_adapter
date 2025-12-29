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

async function startRawServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err?.message ?? String(err));
    }
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

  test('call: supports assistantFirstTurn/timeouts/recording/metadata and request-id header', async () => {
    const expectedResponse = { callConfigId: 'cfg3', providerCallId: 'call3', status: 'queued' };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cli-opts-'));
    const timeoutsPath = path.join(tmpDir, 'timeouts.json');
    fs.writeFileSync(timeoutsPath, JSON.stringify({ callTimeoutMs: 1234, silenceTimeoutMs: 5678 }), 'utf-8');

    const server = await startServer((req, body) => {
      expect(req.url).toBe('/voice/calls');
      expect(req.method).toBe('POST');

      expect(req.headers['x-api-key']).toBe('k');
      expect(req.headers['x-request-id']).toBe('req_123');

      expect(body).toEqual({
        to: '+15550000000',
        from: '+15551111111',
        voiceProvider: 'vp',
        realtimeSpec: { transport: { type: 'ws' } },
        ttlSeconds: 900,
        metadata: { foo: 1 },
        assistantFirstTurn: { enabled: true, prompt: 'hello', role: 'user', delayMs: 250, missingPromptBehavior: 'reject' },
        timeouts: { callTimeoutMs: 1234, silenceTimeoutMs: 5678 },
        recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' }
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
          '--request-id',
          'req_123',
          '--to',
          '+15550000000',
          '--from',
          '+15551111111',
          '--voice-provider',
          'vp',
          '--realtime-spec',
          '{"transport":{"type":"ws"}}',
          '--metadata',
          '{"foo":1}',
          '--assistant-first-turn',
          '{"enabled":true,"prompt":"hello","role":"user","delayMs":250,"missingPromptBehavior":"reject"}',
          '--timeouts-file',
          timeoutsPath,
          '--recording',
          '{"enabled":true,"mode":"provider","format":"mp3","channels":"mono"}'
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    expect(exit).toHaveBeenCalledWith(0);
    expect(JSON.parse(stdout.data)).toEqual(expectedResponse);
    expect(stderr.data).toBe('');
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

  test('end: calls server /voice/calls/:id/end and prints JSON', async () => {
    const server = await startServer((req) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/voice/calls/cfg/end');
      expect(req.headers['x-api-key']).toBe('k');
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
          'end',
          '--server-url',
          server.baseUrl,
          '--api-key',
          'k',
          '--call-config-id',
          'cfg'
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

  test('end: writes server error response to stderr and exits 1', async () => {
    const server = await startServer(() => ({ status: 404, body: { type: 'error', error: { message: 'nope', code: 'not_found' } } }));

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: ['node', 'llm-adapter', 'end', '--server-url', server.baseUrl, '--call-config-id', 'cfg'],
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

    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout.data).toBe('');
    expect(stderr.data).toContain('not_found');
  });

  test('end: writes structured error and exits 1 on invalid input', async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();
    const error = jest.fn();

    await runVoiceCli({
      argv: ['node', 'llm-adapter', 'end', '--server-url', 'not-a-url', '--call-config-id', 'cfg'],
      deps: { error, exit },
      io: {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalled();
  });

  test('events: streams SSE envelopes as JSON lines and supports includeDeltas', async () => {
    const server = await startRawServer((req, res) => {
      const url = new URL(String(req.url), 'http://127.0.0.1');
      expect(url.pathname).toBe('/voice/calls/cfg/events');
      expect(url.searchParams.get('includeDeltas')).toBe('0');
      expect(req.headers.accept).toContain('text/event-stream');

      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(': keepalive\n\n');
      res.write('garbage\n\n');
      res.write('event: voice.test\n');
      // Leading whitespace means this is not treated as a comment line, but has an empty field name.
      res.write(' :ignored\n');
      // A blank-ish line inside the block should be ignored.
      res.write(' \n');
      res.write('data: {\"seq\":1}\n\n');
      // Trailing event without a blank line (covers flush-on-eof path)
      res.end(': keepalive\ndata: {\"seq\":2}\ngarbage\n');
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: [
          'node',
          'llm-adapter',
          'events',
          '--server-url',
          server.baseUrl,
          '--api-key',
          'k',
          '--call-config-id',
          'cfg',
          '--include-deltas',
          '0'
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
    expect(stderr.data).toBe('');
    const lines = stdout.data.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    expect(lines.map(l => JSON.parse(l))).toEqual([{ seq: 1 }, { seq: 2 }]);
  });

  test('events: exits 0 when SSE response has no body (204)', async () => {
    const server = await startRawServer((req, res) => {
      expect(req.url).toBe('/voice/calls/cfg/events');
      res.writeHead(204);
      res.end();
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: ['node', 'llm-adapter', 'events', '--server-url', server.baseUrl, '--call-config-id', 'cfg'],
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
    expect(stdout.data).toBe('');
    expect(stderr.data).toBe('');
  });

  test('events: passes eventTypes allowlist when provided', async () => {
    const server = await startRawServer((req, res) => {
      const url = new URL(String(req.url), 'http://127.0.0.1');
      expect(url.pathname).toBe('/voice/calls/cfg/events');
      expect(url.searchParams.get('eventTypes')).toBe('user_transcript.final,assistant_transcript.final');
      res.writeHead(204);
      res.end();
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: [
          'node',
          'llm-adapter',
          'events',
          '--server-url',
          server.baseUrl,
          '--call-config-id',
          'cfg',
          '--event-types',
          'user_transcript.final,assistant_transcript.final'
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
    expect(stdout.data).toBe('');
    expect(stderr.data).toBe('');
  });

  test('events: writes server error response to stderr and exits 1', async () => {
    const server = await startRawServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('nope');
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: ['node', 'llm-adapter', 'events', '--server-url', server.baseUrl, '--call-config-id', 'cfg'],
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

    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout.data).toBe('');
    expect(stderr.data).toContain('nope');
  });

  test('events: writes empty error body when response text throws', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
      ok: false,
      text: jest.fn(async () => {
        throw new Error('boom');
      })
    } as any);

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: ['node', 'llm-adapter', 'events', '--server-url', 'http://127.0.0.1:1234', '--call-config-id', 'cfg'],
        deps: { error: jest.fn(), exit },
        io: {
          stdin: Readable.from([]),
          stdout: stdout.stream,
          stderr: stderr.stream
        }
      });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout.data).toBe('');
    expect(stderr.data).toBe('\n');
  });

  test('events: writes structured error and exits 1 on invalid input', async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();
    const error = jest.fn();

    await runVoiceCli({
      argv: ['node', 'llm-adapter', 'events', '--server-url', 'not-a-url', '--call-config-id', 'cfg'],
      deps: { error, exit },
      io: {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalled();
  });

  test('recording: downloads bytes to file (and supports 204 empty)', async () => {
    const server = await startRawServer((req, res) => {
      if (req.url === '/voice/calls/cfg/recording') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('ABC');
        return;
      }
      if (req.url === '/voice/calls/empty/recording') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end('nope');
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cli-rec-'));
    const outPath = path.join(tmpDir, 'call.bin');
    const outEmptyPath = path.join(tmpDir, 'call-empty.bin');

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: ['node', 'llm-adapter', 'recording', '--server-url', server.baseUrl, '--call-config-id', 'cfg', '--output', outPath],
        deps: { error: jest.fn(), exit },
        io: {
          stdin: Readable.from([]),
          stdout: stdout.stream,
          stderr: stderr.stream
        }
      });

      await runVoiceCli({
        argv: ['node', 'llm-adapter', 'recording', '--server-url', server.baseUrl, '--call-config-id', 'empty', '--output', outEmptyPath],
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
    expect(fs.readFileSync(outPath, 'utf-8')).toBe('ABC');
    expect(fs.readFileSync(outEmptyPath)).toEqual(Buffer.from([]));
    expect(stdout.data).toBe('');
    expect(stderr.data).toBe('');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('recording: writes bytes to stdout when --output is omitted', async () => {
    const server = await startRawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('XYZ');
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: ['node', 'llm-adapter', 'recording', '--server-url', server.baseUrl, '--call-config-id', 'cfg'],
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
    expect(stdout.data).toBe('XYZ');
    expect(stderr.data).toBe('');
  });

  test('recording: writes server error response to stderr and exits 1', async () => {
    const server = await startRawServer((_req, res) => {
      res.writeHead(409, { 'Content-Type': 'text/plain' });
      res.end('recording_not_ready');
    });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: ['node', 'llm-adapter', 'recording', '--server-url', server.baseUrl, '--call-config-id', 'cfg'],
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

    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout.data).toBe('');
    expect(stderr.data).toContain('recording_not_ready');
  });

  test('recording: writes empty error body when response text throws', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
      ok: false,
      text: jest.fn(async () => {
        throw new Error('boom');
      })
    } as any);

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();

    try {
      await runVoiceCli({
        argv: ['node', 'llm-adapter', 'recording', '--server-url', 'http://127.0.0.1:1234', '--call-config-id', 'cfg'],
        deps: { error: jest.fn(), exit },
        io: {
          stdin: Readable.from([]),
          stdout: stdout.stream,
          stderr: stderr.stream
        }
      });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout.data).toBe('');
    expect(stderr.data).toBe('\n');
  });

  test('recording: supports api-key header name and exits 1 on invalid input', async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const exit = jest.fn();
    const error = jest.fn();

    await runVoiceCli({
      argv: [
        'node',
        'llm-adapter',
        'recording',
        '--server-url',
        'not-a-url',
        '--api-key',
        'k',
        '--api-key-header-name',
        'x-test-key',
        '--call-config-id',
        'cfg'
      ],
      deps: { error, exit },
      io: {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalled();
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
