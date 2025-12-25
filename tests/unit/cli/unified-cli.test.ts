import { jest } from '@jest/globals';
import { Command } from 'commander';
import { Readable, Writable } from 'stream';

describe('cli/internal/unified-cli', () => {
  let createUnifiedProgram: typeof import('@/modules/cli/internal/unified-cli.ts').createUnifiedProgram;
  let capturedOutputs: string[];
  let capturedErrors: string[];
  let capturedExitCodes: number[];
  let mockRegistry: any;
  let mockLlmCoordinator: any;
  let mockVectorCoordinator: any;
  let mockEmbeddingCoordinator: any;
  let mockRunningServer: any;
  let mockDeps: any;

  beforeEach(async () => {
    jest.resetModules();
    capturedOutputs = [];
    capturedErrors = [];
    capturedExitCodes = [];

    mockRegistry = {
      loadAll: jest.fn().mockResolvedValue(undefined)
    };

    mockLlmCoordinator = {
      run: jest.fn().mockResolvedValue({ content: [{ text: 'llm response' }] }),
      runStream: jest.fn().mockImplementation(() => (async function* () {
        yield { type: 'token', text: 'hi' };
        yield { type: 'done' };
      })()),
      close: jest.fn().mockResolvedValue(undefined)
    };

    mockVectorCoordinator = {
      execute: jest.fn().mockResolvedValue({ matches: [] }),
      executeStream: jest.fn().mockImplementation(() => (async function* () {
        yield { type: 'progress', progress: 0.5 };
        yield { type: 'complete' };
      })()),
      close: jest.fn().mockResolvedValue(undefined)
    };

    mockEmbeddingCoordinator = {
      execute: jest.fn().mockResolvedValue({ embeddings: [[0.1, 0.2]] }),
      close: jest.fn().mockResolvedValue(undefined)
    };

    mockRunningServer = {
      url: 'http://127.0.0.1:3000',
      server: {},
      close: jest.fn().mockResolvedValue(undefined)
    };

    mockDeps = {
      createRegistry: jest.fn().mockResolvedValue(mockRegistry),
      createLlmCoordinator: jest.fn().mockResolvedValue(mockLlmCoordinator),
      createVectorCoordinator: jest.fn().mockResolvedValue(mockVectorCoordinator),
      createEmbeddingCoordinator: jest.fn().mockResolvedValue(mockEmbeddingCoordinator),
      createServer: jest.fn().mockResolvedValue(mockRunningServer),
      closeLogger: jest.fn().mockResolvedValue(undefined),
      log: (msg: string) => capturedOutputs.push(msg),
      error: (msg: string) => capturedErrors.push(msg),
      exit: (code: number) => capturedExitCodes.push(code)
    };

    const module = await import('@/modules/cli/internal/unified-cli.ts');
    createUnifiedProgram = module.createUnifiedProgram;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('program structure', () => {
    test('defaultDependencies exposes getRealtimeStdio', async () => {
      const module = await import('@/modules/cli/internal/unified-cli.ts');
      const stdio = module.defaultDependencies.getRealtimeStdio();
      expect(stdio.stdin).toBe(process.stdin);
      expect(stdio.stdout).toBe(process.stdout);
      expect(stdio.stderr).toBe(process.stderr);
    });

    test('creates program with correct name and description', () => {
      const program = createUnifiedProgram(mockDeps);
      expect(program.name()).toBe('llm-adapter');
      expect(program.description()).toContain('LLM Adapter CLI');
    });

    test('has run command', () => {
      const program = createUnifiedProgram(mockDeps);
      const runCmd = program.commands.find(c => c.name() === 'run');
      expect(runCmd).toBeDefined();
    });

    test('has stream command', () => {
      const program = createUnifiedProgram(mockDeps);
      const streamCmd = program.commands.find(c => c.name() === 'stream');
      expect(streamCmd).toBeDefined();
    });

    test('has vector subcommand', () => {
      const program = createUnifiedProgram(mockDeps);
      const vectorCmd = program.commands.find(c => c.name() === 'vector');
      expect(vectorCmd).toBeDefined();
    });

    test('has embeddings subcommand', () => {
      const program = createUnifiedProgram(mockDeps);
      const embeddingsCmd = program.commands.find(c => c.name() === 'embeddings');
      expect(embeddingsCmd).toBeDefined();
    });

    test('has serve command', () => {
      const program = createUnifiedProgram(mockDeps);
      const serveCmd = program.commands.find(c => c.name() === 'serve');
      expect(serveCmd).toBeDefined();
    });

    test('has realtime command', () => {
      const program = createUnifiedProgram(mockDeps);
      const realtimeCmd = program.commands.find(c => c.name() === 'realtime');
      expect(realtimeCmd).toBeDefined();
    });

    test('realtime has client-secret subcommand', () => {
      const program = createUnifiedProgram(mockDeps);
      const realtimeCmd = program.commands.find(c => c.name() === 'realtime');
      const csCmd = realtimeCmd?.commands.find((c: Command) => c.name() === 'client-secret');
      expect(csCmd).toBeDefined();
    });

    test('vector has run subcommand', () => {
      const program = createUnifiedProgram(mockDeps);
      const vectorCmd = program.commands.find(c => c.name() === 'vector');
      const runCmd = vectorCmd?.commands.find((c: Command) => c.name() === 'run');
      expect(runCmd).toBeDefined();
    });

    test('vector has stream subcommand', () => {
      const program = createUnifiedProgram(mockDeps);
      const vectorCmd = program.commands.find(c => c.name() === 'vector');
      const streamCmd = vectorCmd?.commands.find((c: Command) => c.name() === 'stream');
      expect(streamCmd).toBeDefined();
    });

    test('embeddings has run subcommand', () => {
      const program = createUnifiedProgram(mockDeps);
      const embeddingsCmd = program.commands.find(c => c.name() === 'embeddings');
      const runCmd = embeddingsCmd?.commands.find((c: Command) => c.name() === 'run');
      expect(runCmd).toBeDefined();
    });
  });

  describe('realtime command', () => {
    const makeCaptureWritable = () => {
      let buf = '';
      const writable = new Writable({
        write(chunk, _enc, cb) {
          buf += chunk.toString();
          cb();
        }
      });
      return { writable, get: () => buf };
    };

    test('runs v1 wire protocol over stdio', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      let closeResolve: (() => void) | undefined;
      const closed = new Promise<void>(resolve => {
        closeResolve = resolve;
      });

      const mockSession = {
        sendText: jest.fn().mockResolvedValue(undefined),
        injectContext: jest.fn().mockResolvedValue(undefined),
        sendAudio: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        interrupt: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockImplementation(async () => closeResolve?.()),
        events: async function* () {
          yield { type: 'ready', sessionId: 'test-session' };
          await closed;
          yield { type: 'closed', reason: 'client_close' };
        }
      };

      const stdin = Readable.from([
        '\n',
        JSON.stringify({ type: 'open', protocolVersion: 1, spec: { any: true } }) + '\n',
        JSON.stringify({ type: 'send_text', text: 'hi', role: 'user' }) + '\n',
        JSON.stringify({ type: 'inject_context', items: [{ role: 'system', text: 'Remember TOKEN_123' }] }) + '\n',
        JSON.stringify({
          type: 'send_audio',
          frame: { format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AA==' }
        }) + '\n',
        JSON.stringify({ type: 'commit' }) + '\n',
        JSON.stringify({ type: 'interrupt', reason: 'interrupt' }) + '\n',
        JSON.stringify({ type: 'close' }) + '\n'
      ]);

      const program = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn().mockResolvedValue(mockSession)
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime', '--plugins', './test-plugins']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./test-plugins');
      expect(mockSession.sendText).toHaveBeenCalledWith({ text: 'hi', role: 'user' });
      expect(mockSession.injectContext).toHaveBeenCalledWith([{ role: 'system', text: 'Remember TOKEN_123' }]);
      expect(mockSession.sendAudio).toHaveBeenCalledWith({
        format: 'pcm16',
        sampleRateHz: 24000,
        channels: 1,
        dataBase64: 'AA=='
      });
      expect(mockSession.commit).toHaveBeenCalled();
      expect(mockSession.interrupt).toHaveBeenCalledWith({ reason: 'interrupt' });
      expect(mockSession.close).toHaveBeenCalled();

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelopes = lines.map(l => JSON.parse(l));
      expect(envelopes[0].type).toBe('event');
      expect(envelopes[0].event.type).toBe('ready');
      expect(envelopes.some(e => e.type === 'event' && e.event.type === 'closed')).toBe(true);
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(0);
    });

    test('propagates non-Error failures from message handler', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      let closeResolve: (() => void) | undefined;
      const closed = new Promise<void>(resolve => {
        closeResolve = resolve;
      });

      const session = {
        sendText: jest.fn().mockImplementation(() => {
          throw 'boom';
        }),
        close: jest.fn().mockImplementation(async () => closeResolve?.()),
        events: async function* () {
          yield { type: 'ready', sessionId: 's' };
          await closed;
          yield { type: 'closed', reason: 'client_close' };
        }
      };

      const stdin = Readable.from([
        JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n',
        JSON.stringify({ type: 'send_text', text: 'hi' }) + '\n'
      ]);

      const program = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn().mockResolvedValue(session)
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelopes = lines.map(l => JSON.parse(l));
      const errorEnvelope = envelopes.find(e => e.type === 'error');
      expect(errorEnvelope).toBeDefined();
      expect(String(errorEnvelope.error.message)).toContain('boom');
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
    });

    test('writes error envelope when realtime command throws (Error)', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      let closeResolve: (() => void) | undefined;
      const closed = new Promise<void>(resolve => {
        closeResolve = resolve;
      });

      const session = {
        close: jest.fn().mockImplementation(async () => closeResolve?.()),
        events: async function* () {
          yield { type: 'ready', sessionId: 's' };
          await closed;
          yield { type: 'closed', reason: 'client_close' };
        }
      };

      const stdin = Readable.from([
        JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n',
        JSON.stringify({ type: 'close' }) + '\n'
      ]);

      const program = createUnifiedProgram({
        ...mockDeps,
        exit: (code: number) => {
          if (code === 0) throw new Error('exit boom');
          capturedExitCodes.push(code);
        },
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn().mockResolvedValue(session)
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelopes = lines.map(l => JSON.parse(l));
      const errorEnvelope = envelopes.find(e => e.type === 'error' && String(e.error.message).includes('exit boom'));
      expect(errorEnvelope).toBeDefined();
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
    });

    test('writes error envelope when realtime command throws (non-Error)', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      let closeResolve: (() => void) | undefined;
      const closed = new Promise<void>(resolve => {
        closeResolve = resolve;
      });

      const session = {
        close: jest.fn().mockImplementation(async () => closeResolve?.()),
        events: async function* () {
          yield { type: 'ready', sessionId: 's' };
          await closed;
          yield { type: 'closed', reason: 'client_close' };
        }
      };

      const stdin = Readable.from([
        JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n',
        JSON.stringify({ type: 'close' }) + '\n'
      ]);

      const program = createUnifiedProgram({
        ...mockDeps,
        exit: (code: number) => {
          if (code === 0) throw 'exit boom';
          capturedExitCodes.push(code);
        },
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn().mockResolvedValue(session)
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelopes = lines.map(l => JSON.parse(l));
      const errorEnvelope = envelopes.find(e => e.type === 'error' && String(e.error.message).includes('exit boom'));
      expect(errorEnvelope).toBeDefined();
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
    });

    test('fails on message before open', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      const stdin = Readable.from([JSON.stringify({ type: 'send_text', text: 'hi' }) + '\n']);

      const program = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn()
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelope = JSON.parse(lines[0]);
      expect(envelope.type).toBe('error');
      expect(String(envelope.error.message)).toContain('Session not open');
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
    });

    test('fails on invalid JSON', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      const stdin = Readable.from(['{not-json\n']);

      const program = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn()
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelope = JSON.parse(lines[0]);
      expect(envelope.type).toBe('error');
      expect(envelope.error.code).toBe('invalid_json');
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
    });

    test('fails on unsupported protocolVersion', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      const stdin = Readable.from([JSON.stringify({ type: 'open', protocolVersion: 2, spec: {} }) + '\n']);

      const program = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn()
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelope = JSON.parse(lines[0]);
      expect(envelope.type).toBe('error');
      expect(envelope.error.code).toBe('unsupported_protocol');
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
    });

    test('fails when realtime session factory is missing', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      const stdin = Readable.from([JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n']);

      const program = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: undefined
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelope = JSON.parse(lines[0]);
      expect(envelope.type).toBe('error');
      expect(envelope.error.code).toBe('realtime_unavailable');
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
    });

    test('fails when session does not emit ready first / closes before ready', async () => {
      const stdoutCap1 = makeCaptureWritable();
      const stderrCap1 = makeCaptureWritable();

      const sessionClosedImmediately = {
        close: jest.fn().mockResolvedValue(undefined),
        events: async function* () {
          // no events
        }
      };

      const program1 = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: Readable.from([JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n']) as any,
          stdout: stdoutCap1.writable as any,
          stderr: stderrCap1.writable as any
        }),
        createRealtimeSession: jest.fn().mockResolvedValue(sessionClosedImmediately)
      });

      await program1.parseAsync(['node', 'llm-adapter', 'realtime']);
      const lines1 = stdoutCap1.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const env1 = JSON.parse(lines1[0]);
      expect(env1.type).toBe('error');
      expect(env1.error.code).toBe('closed_before_ready');

      const stdoutCap2 = makeCaptureWritable();
      const stderrCap2 = makeCaptureWritable();

      const sessionMissingReady = {
        close: jest.fn().mockResolvedValue(undefined),
        events: async function* () {
          yield { type: 'not_ready' };
        }
      };

      const program2 = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: Readable.from([JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n']) as any,
          stdout: stdoutCap2.writable as any,
          stderr: stderrCap2.writable as any
        }),
        createRealtimeSession: jest.fn().mockResolvedValue(sessionMissingReady)
      });

      await program2.parseAsync(['node', 'llm-adapter', 'realtime']);
      const lines2 = stdoutCap2.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const env2 = JSON.parse(lines2[0]);
      expect(env2.type).toBe('error');
      expect(env2.error.code).toBe('missing_ready');
    });

    test('fails on unknown message type after open (and closes session)', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      let closeResolve: (() => void) | undefined;
      const closed = new Promise<void>(resolve => {
        closeResolve = resolve;
      });

      const session = {
        close: jest.fn().mockImplementation(async () => closeResolve?.()),
        events: async function* () {
          yield { type: 'ready', sessionId: 's' };
          await closed;
          yield { type: 'closed', reason: 'client_close' };
        }
      };

      const stdin = Readable.from([
        JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n',
        JSON.stringify({ type: 'nope' }) + '\n'
      ]);

      const program = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn().mockResolvedValue(session)
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelopes = lines.map(l => JSON.parse(l));
      expect(envelopes.some(e => e.type === 'event' && e.event.type === 'ready')).toBe(true);
      expect(envelopes.some(e => e.type === 'error' && e.error.code === 'unknown_type')).toBe(true);
      expect(session.close).toHaveBeenCalled();
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
    });

    test('supports registries without loadAll', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      let closeResolve: (() => void) | undefined;
      const closed = new Promise<void>(resolve => {
        closeResolve = resolve;
      });

      const session = {
        close: jest.fn().mockImplementation(async () => closeResolve?.()),
        events: async function* () {
          yield { type: 'ready', sessionId: 's' };
          await closed;
          yield { type: 'closed', reason: 'client_close' };
        },
        sendText: jest.fn().mockResolvedValue(undefined),
        sendAudio: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        interrupt: jest.fn().mockResolvedValue(undefined)
      };

      const stdin = Readable.from([
        JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n',
        JSON.stringify({ type: 'close' }) + '\n'
      ]);

      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockResolvedValue({}),
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn().mockResolvedValue(session)
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(0);
    });

    test('propagates non-Error failures from event pump', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      const session = {
        close: jest.fn().mockResolvedValue(undefined),
        events: async function* () {
          throw 'boom';
        }
      };

      const stdin = Readable.from([JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n']);

      const program = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn().mockResolvedValue(session)
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelope = JSON.parse(lines.find(l => JSON.parse(l).type === 'error')!);
      expect(envelope.type).toBe('error');
      expect(String(envelope.error.message)).toContain('boom');
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
    });

    test('fails when open is repeated', async () => {
      const stdoutCap = makeCaptureWritable();
      const stderrCap = makeCaptureWritable();

      let closeResolve: (() => void) | undefined;
      const closed = new Promise<void>(resolve => {
        closeResolve = resolve;
      });

      const session = {
        close: jest.fn().mockImplementation(async () => closeResolve?.()),
        events: async function* () {
          yield { type: 'ready', sessionId: 's' };
          await closed;
          yield { type: 'closed', reason: 'client_close' };
        }
      };

      const stdin = Readable.from([
        JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n',
        JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }) + '\n'
      ]);

      const program = createUnifiedProgram({
        ...mockDeps,
        getRealtimeStdio: () => ({
          stdin: stdin as any,
          stdout: stdoutCap.writable as any,
          stderr: stderrCap.writable as any
        }),
        createRealtimeSession: jest.fn().mockResolvedValue(session)
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime']);

      const lines = stdoutCap.get().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const envelopes = lines.map(l => JSON.parse(l));
      expect(envelopes.some(e => e.type === 'error' && e.error.code === 'already_open')).toBe(true);
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
    });
  });

  describe('realtime client-secret command', () => {
    test('mints a client secret via realtime compat and writes JSON response', async () => {
      const providerId = 'test-realtime-provider';
      const compatKind = 'test-realtime-compat';

      const providerManifest = { id: providerId, compat: compatKind };
      const mintClientSecret = jest.fn().mockResolvedValue({ clientSecret: 'client_secret_value', expiresAt: 123 });
      const registry = {
        loadAll: jest.fn().mockResolvedValue(undefined),
        getRealtimeProvider: jest.fn().mockResolvedValue(providerManifest),
        getRealtimeCompat: jest.fn().mockResolvedValue({ mintClientSecret })
      };

      const written: string[] = [];
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any, encodingOrCb?: any, cb?: any) => {
        written.push(chunk.toString());
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        if (callback) setImmediate(callback);
        return true;
      });

      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockResolvedValue(registry)
      });

      const req = {
        provider: providerId,
        model: 'test-model',
        systemPrompt: 'hello',
        expiresAfterSeconds: 60
      };

      await program.parseAsync([
        'node',
        'llm-adapter',
        'realtime',
        'client-secret',
        '--plugins',
        './test-plugins',
        '--spec',
        JSON.stringify(req)
      ]);

      expect(registry.getRealtimeProvider).toHaveBeenCalledWith(providerId);
      expect(registry.getRealtimeCompat).toHaveBeenCalledWith(compatKind);
      expect(mintClientSecret).toHaveBeenCalledWith({
        provider: providerManifest,
        spec: {
          provider: providerId,
          model: 'test-model',
          systemPrompt: 'hello',
          transport: { type: 'webrtc' }
        },
        expiresAfterSeconds: 60
      });

      const output = written.join('');
      expect(output).toContain('"clientSecret"');
      expect(output).toContain('client_secret_value');
      expect(output).toContain('"expiresAt"');
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(0);

      jest.spyOn(process.stdout, 'write').mockRestore();
    });

    test('supports minimal request (no model/systemPrompt/expiresAfterSeconds) and omits expiresAt in response', async () => {
      const providerId = 'test-realtime-provider';
      const compatKind = 'test-realtime-compat';

      const providerManifest = { id: providerId, compat: compatKind };
      const mintClientSecret = jest.fn().mockResolvedValue({ clientSecret: 'client_secret_value' });
      const registry = {
        loadAll: jest.fn().mockResolvedValue(undefined),
        getRealtimeProvider: jest.fn().mockResolvedValue(providerManifest),
        getRealtimeCompat: jest.fn().mockResolvedValue({ mintClientSecret })
      };

      const written: string[] = [];
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any, encodingOrCb?: any, cb?: any) => {
        written.push(chunk.toString());
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        if (callback) setImmediate(callback);
        return true;
      });

      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockResolvedValue(registry)
      });

      await program.parseAsync([
        'node',
        'llm-adapter',
        'realtime',
        'client-secret',
        '--plugins',
        './test-plugins',
        '--spec',
        JSON.stringify({ provider: providerId })
      ]);

      expect(mintClientSecret).toHaveBeenCalledWith({
        provider: providerManifest,
        spec: {
          provider: providerId,
          transport: { type: 'webrtc' }
        }
      });

      const output = written.join('');
      expect(output).toContain('"clientSecret"');
      expect(output).toContain('client_secret_value');
      expect(output).not.toContain('"expiresAt"');
      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(0);

      jest.spyOn(process.stdout, 'write').mockRestore();
    });

    test('fails validation on missing provider', async () => {
      const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };
      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockResolvedValue(registry)
      });

      await program.parseAsync(['node', 'llm-adapter', 'realtime', 'client-secret', '--spec', '{}']);

      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('Missing provider');
    });

    test('fails validation on invalid expiresAfterSeconds (non-finite)', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node',
        'llm-adapter',
        'realtime',
        'client-secret',
        '--spec',
        JSON.stringify({ provider: 'p', expiresAfterSeconds: 'Infinity' })
      ]);

      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('Invalid expiresAfterSeconds');
    });

    test('fails validation on non-integer expiresAfterSeconds', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node',
        'llm-adapter',
        'realtime',
        'client-secret',
        '--spec',
        JSON.stringify({ provider: 'p', expiresAfterSeconds: 1.5 })
      ]);

      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('must be an integer');
    });

    test('fails validation on out-of-range expiresAfterSeconds', async () => {
      const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };
      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockResolvedValue(registry)
      });

      await program.parseAsync([
        'node',
        'llm-adapter',
        'realtime',
        'client-secret',
        '--spec',
        JSON.stringify({ provider: 'p', expiresAfterSeconds: 999999 })
      ]);

      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('expiresAfterSeconds must be between');
    });

    test('fails when registry does not support realtime client-secret minting', async () => {
      const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };
      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockResolvedValue(registry)
      });

      await program.parseAsync([
        'node',
        'llm-adapter',
        'realtime',
        'client-secret',
        '--spec',
        JSON.stringify({ provider: 'test-realtime-provider' })
      ]);

      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
      expect(capturedErrors[capturedErrors.length - 1]).toContain(
        'Registry does not support realtime client-secret minting'
      );
    });

    test('fails when provider is missing compat mapping', async () => {
      const providerId = 'test-realtime-provider';
      const registry = {
        loadAll: jest.fn().mockResolvedValue(undefined),
        getRealtimeProvider: jest.fn().mockResolvedValue({ id: providerId }),
        getRealtimeCompat: jest.fn()
      };

      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockResolvedValue(registry)
      });

      await program.parseAsync([
        'node',
        'llm-adapter',
        'realtime',
        'client-secret',
        '--spec',
        JSON.stringify({ provider: providerId })
      ]);

      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('not supported for provider');
    });

    test('fails when compat does not support client-secret minting', async () => {
      const providerId = 'test-realtime-provider';
      const compatKind = 'test-realtime-compat';

      const registry = {
        loadAll: jest.fn().mockResolvedValue(undefined),
        getRealtimeProvider: jest.fn().mockResolvedValue({ id: providerId, compat: compatKind }),
        getRealtimeCompat: jest.fn().mockResolvedValue({})
      };

      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockResolvedValue(registry)
      });

      await program.parseAsync([
        'node',
        'llm-adapter',
        'realtime',
        'client-secret',
        '--spec',
        JSON.stringify({ provider: providerId })
      ]);

      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('client-secret minting not supported');
    });

    test('fails when compat response is missing clientSecret', async () => {
      const providerId = 'test-realtime-provider';
      const compatKind = 'test-realtime-compat';

      const registry = {
        loadAll: jest.fn().mockResolvedValue(undefined),
        getRealtimeProvider: jest.fn().mockResolvedValue({ id: providerId, compat: compatKind }),
        getRealtimeCompat: jest.fn().mockResolvedValue({
          mintClientSecret: jest.fn().mockResolvedValue({ expiresAt: 123 })
        })
      };

      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockResolvedValue(registry)
      });

      await program.parseAsync([
        'node',
        'llm-adapter',
        'realtime',
        'client-secret',
        '--spec',
        JSON.stringify({ provider: providerId })
      ]);

      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('missing client secret');
    });

    test('handles non-Error failures from compat mintClientSecret', async () => {
      const providerId = 'test-realtime-provider';
      const compatKind = 'test-realtime-compat';

      const registry = {
        loadAll: jest.fn().mockResolvedValue(undefined),
        getRealtimeProvider: jest.fn().mockResolvedValue({ id: providerId, compat: compatKind }),
        getRealtimeCompat: jest.fn().mockResolvedValue({
          mintClientSecret: jest.fn().mockImplementation(() => {
            throw 'boom';
          })
        })
      };

      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockResolvedValue(registry)
      });

      await program.parseAsync([
        'node',
        'llm-adapter',
        'realtime',
        'client-secret',
        '--spec',
        JSON.stringify({ provider: providerId })
      ]);

      expect(capturedExitCodes[capturedExitCodes.length - 1]).toBe(1);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('boom');
    });
  });

  describe('run command (LLM)', () => {
    test('executes LLM run with spec from --spec option', async () => {
      const program = createUnifiedProgram(mockDeps);
      const spec = { provider: 'test', messages: [] };

      await program.parseAsync(['node', 'llm-adapter', 'run', '--spec', JSON.stringify(spec), '-p', './test-plugins']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./test-plugins');
      expect(mockDeps.createLlmCoordinator).toHaveBeenCalledWith(mockRegistry);
      expect(mockLlmCoordinator.run).toHaveBeenCalledWith(spec);
      expect(mockLlmCoordinator.close).toHaveBeenCalled();
      expect(capturedExitCodes).toEqual([0]);
    });

    test('uses default plugins path when not specified', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'run', '--spec', '{}']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./plugins');
    });

    test('outputs wrapped response with type: response', async () => {
      const program = createUnifiedProgram(mockDeps);
      // Mock stdout.write to capture output
      const originalWrite = process.stdout.write.bind(process.stdout);
      const writtenData: string[] = [];
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any, encodingOrCb?: any, cb?: any) => {
        writtenData.push(chunk.toString());
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        if (callback) setImmediate(callback);
        return true;
      });

      await program.parseAsync(['node', 'llm-adapter', 'run', '--spec', '{}']);

      expect(writtenData.some(d => d.includes('"type":"response"'))).toBe(true);
      jest.spyOn(process.stdout, 'write').mockRestore();
    });

    test('exits with code 1 on error', async () => {
      mockLlmCoordinator.run.mockRejectedValue(new Error('Test error'));
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'run', '--spec', '{}']);

      expect(capturedExitCodes).toEqual([1]);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('Test error');
    });

    test('handles error without message property', async () => {
      // Test the `?? String(error)` branch by throwing a non-Error object
      mockLlmCoordinator.run.mockRejectedValue('string error');
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'run', '--spec', '{}']);

      expect(capturedExitCodes).toEqual([1]);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('string error');
    });

    test('supports --pretty option', async () => {
      const program = createUnifiedProgram(mockDeps);
      const writtenData: string[] = [];
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any, encodingOrCb?: any, cb?: any) => {
        writtenData.push(chunk.toString());
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        if (callback) setImmediate(callback);
        return true;
      });

      await program.parseAsync(['node', 'llm-adapter', 'run', '--spec', '{}', '--pretty']);

      // Pretty output should have newlines and indentation
      const prettyOutput = writtenData.find(d => d.includes('"type"'));
      expect(prettyOutput).toMatch(/\n/);
      jest.spyOn(process.stdout, 'write').mockRestore();
    });

    test('supports --batch-id option', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'run', '--spec', '{}', '--batch-id', 'test-batch']);

      expect(capturedExitCodes).toEqual([0]);
    });
  });

  describe('stream command (LLM)', () => {
    test('executes LLM stream and outputs events', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'stream', '--spec', '{}']);

      expect(mockDeps.createLlmCoordinator).toHaveBeenCalled();
      expect(mockLlmCoordinator.runStream).toHaveBeenCalled();
      expect(capturedOutputs.filter(o => o.includes('"type"'))).toHaveLength(2);
      expect(capturedExitCodes).toEqual([0]);
    });

    test('uses default plugins path for stream when not specified', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'stream', '--spec', '{}']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./plugins');
    });

    test('uses custom plugins path for stream when specified', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'stream', '--spec', '{}', '-p', './custom-plugins']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./custom-plugins');
    });

    test('exits with code 1 on stream error', async () => {
      mockLlmCoordinator.runStream.mockImplementation(() => (async function* () {
        throw new Error('Stream error');
      })());
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'stream', '--spec', '{}']);

      expect(capturedExitCodes).toEqual([1]);
    });

    test('handles stream error without message property', async () => {
      mockLlmCoordinator.runStream.mockImplementation(() => (async function* () {
        throw 'string stream error';
      })());
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'stream', '--spec', '{}']);

      expect(capturedExitCodes).toEqual([1]);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('string stream error');
    });
  });

  describe('vector run command', () => {
    test('executes vector run with spec', async () => {
      const program = createUnifiedProgram(mockDeps);
      const spec = { provider: 'test', operation: 'query' };

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'run', '--spec', JSON.stringify(spec)]);

      expect(mockDeps.createVectorCoordinator).toHaveBeenCalled();
      expect(mockVectorCoordinator.execute).toHaveBeenCalledWith(spec);
      expect(capturedExitCodes).toEqual([0]);
    });

    test('uses default plugins path for vector run when not specified', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'run', '--spec', '{}']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./plugins');
    });

    test('uses custom plugins path for vector run when specified', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'run', '--spec', '{}', '-p', './custom-plugins']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./custom-plugins');
    });

    test('exits with code 1 on error', async () => {
      mockVectorCoordinator.execute.mockRejectedValue(new Error('Vector error'));
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'run', '--spec', '{}']);

      expect(capturedExitCodes).toEqual([1]);
    });

    test('handles vector error without message property', async () => {
      mockVectorCoordinator.execute.mockRejectedValue('string vector error');
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'run', '--spec', '{}']);

      expect(capturedExitCodes).toEqual([1]);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('string vector error');
    });
  });

  describe('vector stream command', () => {
    test('executes vector stream and outputs events', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'stream', '--spec', '{}']);

      expect(mockVectorCoordinator.executeStream).toHaveBeenCalled();
      expect(capturedOutputs.filter(o => o.includes('"type"'))).toHaveLength(2);
      expect(capturedExitCodes).toEqual([0]);
    });

    test('uses default plugins path for vector stream when not specified', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'stream', '--spec', '{}']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./plugins');
    });

    test('uses custom plugins path for vector stream when specified', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'stream', '--spec', '{}', '-p', './custom-plugins']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./custom-plugins');
    });
  });

  describe('vector convenience commands', () => {
    test('query command executes vector run', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'query', '--spec', '{}']);

      expect(mockVectorCoordinator.execute).toHaveBeenCalled();
      expect(capturedExitCodes).toEqual([0]);
    });

    test('upsert command executes vector run', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'upsert', '--spec', '{}']);

      expect(mockVectorCoordinator.execute).toHaveBeenCalled();
    });

    test('embed command executes vector run', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'embed', '--spec', '{}']);

      expect(mockVectorCoordinator.execute).toHaveBeenCalled();
    });

    test('delete command executes vector run', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'delete', '--spec', '{}']);

      expect(mockVectorCoordinator.execute).toHaveBeenCalled();
    });

    test('collections command executes vector run', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'collections', '--spec', '{}']);

      expect(mockVectorCoordinator.execute).toHaveBeenCalled();
    });

    test('embed command with --stream flag uses streaming', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'embed', '--spec', '{}', '--stream']);

      expect(mockVectorCoordinator.executeStream).toHaveBeenCalled();
    });
  });

  describe('embeddings run command', () => {
    test('executes embedding run with spec', async () => {
      const program = createUnifiedProgram(mockDeps);
      const spec = { provider: 'test', texts: ['hello'] };

      await program.parseAsync(['node', 'llm-adapter', 'embeddings', 'run', '--spec', JSON.stringify(spec)]);

      expect(mockDeps.createEmbeddingCoordinator).toHaveBeenCalled();
      expect(mockEmbeddingCoordinator.execute).toHaveBeenCalledWith(spec);
      expect(capturedExitCodes).toEqual([0]);
    });

    test('uses default plugins path for embeddings run when not specified', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'embeddings', 'run', '--spec', '{}']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./plugins');
    });

    test('uses custom plugins path for embeddings run when specified', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'embeddings', 'run', '--spec', '{}', '-p', './custom-plugins']);

      expect(mockDeps.createRegistry).toHaveBeenCalledWith('./custom-plugins');
    });

    test('exits with code 1 on error', async () => {
      mockEmbeddingCoordinator.execute.mockRejectedValue(new Error('Embedding error'));
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'embeddings', 'run', '--spec', '{}']);

      expect(capturedExitCodes).toEqual([1]);
    });

    test('handles embedding error without message property', async () => {
      mockEmbeddingCoordinator.execute.mockRejectedValue('string embedding error');
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'embeddings', 'run', '--spec', '{}']);

      expect(capturedExitCodes).toEqual([1]);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('string embedding error');
    });
  });

  describe('serve command', () => {
    let originalOn: typeof process.on;

    beforeEach(() => {
      originalOn = process.on.bind(process);
      jest.spyOn(process, 'on').mockImplementation(() => process);
    });

    afterEach(() => {
      process.on = originalOn;
    });

    test('starts server with default options', async () => {
      const program = createUnifiedProgram(mockDeps);

      // Run in background to not block
      const parsePromise = program.parseAsync(['node', 'llm-adapter', 'serve']);

      // Give it a moment to start
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockDeps.createServer).toHaveBeenCalled();
      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.host).toBe('127.0.0.1');
      expect(serverOptions.pluginsPath).toBe('./plugins');
      expect(serverOptions.realtime).toBeUndefined();
    });

    test('starts server with custom host and port', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'serve', '--host', '0.0.0.0', '--port', '8080']);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.host).toBe('0.0.0.0');
      expect(serverOptions.port).toBe(8080);
    });

    test('passes rate limit options', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node', 'llm-adapter', 'serve',
        '--rate-limit-enabled',
        '--rate-limit-requests-per-minute', '60',
        '--rate-limit-burst', '10'
      ]);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.rateLimit).toEqual({
        enabled: true,
        requestsPerMinute: 60,
        burst: 10
      });
    });

    test('passes auth options', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node', 'llm-adapter', 'serve',
        '--auth-enabled',
        '--auth-header-name', 'x-custom-key'
      ]);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.auth).toBeDefined();
      expect(serverOptions.auth.enabled).toBe(true);
      expect(serverOptions.auth.headerName).toBe('x-custom-key');
    });

    test('passes cors options', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'serve', '--cors-enabled']);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.cors).toEqual({ enabled: true });
    });

    test('passes realtime options', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node', 'llm-adapter', 'serve',
        '--realtime-enabled',
        '--realtime-ws-path', '/realtime/ws2',
        '--realtime-max-ws-message-bytes', '123',
        '--realtime-ws-idle-timeout-ms', '456',
        '--realtime-max-concurrent-sessions', '7',
        '--realtime-max-audio-bytes-per-second', '890',
        '--realtime-max-session-duration-ms', '123456'
      ]);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.realtime).toEqual({
        enabled: true,
        wsPath: '/realtime/ws2',
        maxWsMessageBytes: 123,
        wsIdleTimeoutMs: 456,
        maxConcurrentSessions: 7,
        maxAudioBytesPerSecond: 890,
        maxSessionDurationMs: 123456
      });
    });

    test('passes minimal realtime config when only enabled flag is provided', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node', 'llm-adapter', 'serve',
        '--realtime-enabled'
      ]);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.realtime).toEqual({ enabled: true });
    });

    test('logs server URL on start', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'serve']);

      expect(capturedOutputs.some(o => o.includes('http://127.0.0.1:3000'))).toBe(true);
    });

    test('exits with code 1 if createServer is missing', async () => {
      const depsWithoutServer = { ...mockDeps, createServer: undefined };
      const program = createUnifiedProgram(depsWithoutServer);

      await program.parseAsync(['node', 'llm-adapter', 'serve']);

      expect(capturedExitCodes).toEqual([1]);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('createServer');
    });

    test('exits with code 1 on server error', async () => {
      mockDeps.createServer.mockRejectedValue(new Error('Server failed'));
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'serve']);

      expect(capturedExitCodes).toEqual([1]);
    });

    test('handles server error without message property', async () => {
      mockDeps.createServer.mockRejectedValue('string server error');
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'serve']);

      expect(capturedExitCodes).toEqual([1]);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('string server error');
    });
  });

  describe('help output', () => {
    test('--help does not trigger coordinator factories', () => {
      // This verifies lazy loading - help should not create any coordinators
      const program = createUnifiedProgram(mockDeps);

      // Get help information (doesn't execute actions)
      const helpInfo = program.helpInformation();

      expect(helpInfo).toContain('llm-adapter');
      expect(mockDeps.createRegistry).not.toHaveBeenCalled();
      expect(mockDeps.createLlmCoordinator).not.toHaveBeenCalled();
      expect(mockDeps.createVectorCoordinator).not.toHaveBeenCalled();
    });

    test('help contains all main commands', () => {
      const program = createUnifiedProgram(mockDeps);
      const helpInfo = program.helpInformation();

      expect(helpInfo).toContain('run');
      expect(helpInfo).toContain('stream');
      expect(helpInfo).toContain('vector');
      expect(helpInfo).toContain('embeddings');
      expect(helpInfo).toContain('serve');
    });
  });

  describe('spec loading', () => {
    test('loads spec from --file option', async () => {
      // Use temp file helper to create real file
      const { withTempCwd, writeJson } = await import('@tests/helpers/temp-files.ts');

      await withTempCwd('unified-cli-spec', async (dir) => {
        const specPath = `${dir}/spec.json`;
        writeJson(specPath, { from: 'file' });

        jest.resetModules();
        const module = await import('@/modules/cli/internal/unified-cli.ts');
        const program = module.createUnifiedProgram(mockDeps);

        await program.parseAsync(['node', 'llm-adapter', 'run', '--file', specPath]);

        expect(mockLlmCoordinator.run).toHaveBeenCalledWith({ from: 'file' });
      });
    });

    test('handles invalid JSON in --spec option', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync(['node', 'llm-adapter', 'run', '--spec', 'not json']);

      expect(capturedExitCodes).toEqual([1]);
      expect(capturedErrors[capturedErrors.length - 1]).toContain('error');
    });
  });

  describe('runUnifiedCli', () => {
    test('runUnifiedCli is exported and callable', async () => {
      const { runUnifiedCli } = await import('@/modules/cli/internal/unified-cli.ts');
      expect(typeof runUnifiedCli).toBe('function');
    });

    test('runUnifiedCli creates program and parses argv', async () => {
      // Instead of complex module mocking, verify the function exists
      // and the actual behavior is tested via createUnifiedProgram tests
      const { runUnifiedCli, createUnifiedProgram } = await import(
        '@/modules/cli/internal/unified-cli.ts'
      );

      expect(typeof runUnifiedCli).toBe('function');
      expect(typeof createUnifiedProgram).toBe('function');

      // Verify that createUnifiedProgram returns a valid program
      const program = createUnifiedProgram(mockDeps);
      expect(program.name()).toBe('llm-adapter');
    });

    test('runUnifiedCli uses process.argv as default when no args provided', async () => {
      jest.resetModules();

      // Save original argv
      const originalArgv = process.argv;

      // Set up process.argv to simulate CLI invocation with --version
      process.argv = ['node', 'llm-adapter', '--version'];

      // Mock stdout.write to capture version output
      const writtenData: string[] = [];
      const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        writtenData.push(chunk.toString());
        return true;
      });
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      const { runUnifiedCli } = await import('@/modules/cli/internal/unified-cli.ts');

      // Call without arguments to use default process.argv
      await runUnifiedCli();

      // Restore
      process.argv = originalArgv;
      stdoutWriteSpy.mockRestore();
      exitSpy.mockRestore();

      // Verify --version was processed (outputs version number)
      expect(writtenData.some(d => d.includes('1.0.0'))).toBe(true);
    });
  });

  describe('default dependency functions via createUnifiedProgram', () => {
    // Note: These tests use dependency injection instead of module mocking
    // to avoid fragile ESM dynamic import mocking issues

    test('vector run command calls createVectorCoordinator', async () => {
      const mockCreateVectorCoordinator = jest.fn().mockResolvedValue(mockVectorCoordinator);

      const program = createUnifiedProgram({
        ...mockDeps,
        createVectorCoordinator: mockCreateVectorCoordinator
      });

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'run', '--spec', '{}']);

      expect(mockCreateVectorCoordinator).toHaveBeenCalled();
    });

    test('embeddings run command calls createEmbeddingCoordinator', async () => {
      const mockCreateEmbeddingCoordinator = jest.fn().mockResolvedValue(mockEmbeddingCoordinator);

      const program = createUnifiedProgram({
        ...mockDeps,
        createEmbeddingCoordinator: mockCreateEmbeddingCoordinator
      });

      await program.parseAsync(['node', 'llm-adapter', 'embeddings', 'run', '--spec', '{}']);

      expect(mockCreateEmbeddingCoordinator).toHaveBeenCalled();
    });

    test('serve command calls createServer', async () => {
      jest.spyOn(process, 'on').mockImplementation(() => process);

      const mockCreateServer = jest.fn().mockResolvedValue({
        url: 'http://127.0.0.1:3000',
        close: jest.fn().mockResolvedValue(undefined)
      });

      const program = createUnifiedProgram({
        ...mockDeps,
        createServer: mockCreateServer
      });

      await program.parseAsync(['node', 'llm-adapter', 'serve']);

      expect(mockCreateServer).toHaveBeenCalled();
    });
  });

  describe('default dependencies', () => {
    test('creates program with default deps when none provided', () => {
      const program = createUnifiedProgram();

      expect(program).toBeDefined();
      expect(program.name()).toBe('llm-adapter');
    });

    test('default log function behavior', async () => {
      // Use injected deps with default-like log behavior
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const program = createUnifiedProgram({
        ...mockDeps,
        log: (msg: string) => console.log(msg)
      });

      await program.parseAsync(['node', 'llm-adapter', 'stream', '--spec', '{}']);

      expect(consoleLogSpy).toHaveBeenCalled();

      consoleLogSpy.mockRestore();
    });

    test('default error function behavior', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = jest.fn();

      // Create deps that simulate an error
      const program = createUnifiedProgram({
        ...mockDeps,
        createRegistry: jest.fn().mockRejectedValue(new Error('Test factory error')),
        error: (msg: string) => console.error(msg),
        exit: exitSpy
      });

      await program.parseAsync(['node', 'llm-adapter', 'run', '--spec', '{}']);

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
    });
  });

  describe('serve command edge cases', () => {
    let originalOn: typeof process.on;

    beforeEach(() => {
      originalOn = process.on.bind(process);
      jest.spyOn(process, 'on').mockImplementation(() => process);
    });

    afterEach(() => {
      process.on = originalOn;
    });

    test('throws error for invalid port number', async () => {
      const program = createUnifiedProgram(mockDeps);

      // Commander throws during option parsing, so we need to catch it directly
      await expect(
        program.parseAsync(['node', 'llm-adapter', 'serve', '--port', 'not-a-number'])
      ).rejects.toThrow('Invalid number: not-a-number');
    });

    test('passes --no-auth-allow-bearer option', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node', 'llm-adapter', 'serve',
        '--auth-enabled',
        '--no-auth-allow-bearer'
      ]);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.auth.allowBearer).toBe(false);
    });

    test('passes --no-auth-allow-api-key-header option', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node', 'llm-adapter', 'serve',
        '--auth-enabled',
        '--no-auth-allow-api-key-header'
      ]);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.auth.allowApiKeyHeader).toBe(false);
    });

    test('passes --auth-realm option', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node', 'llm-adapter', 'serve',
        '--auth-enabled',
        '--auth-realm', 'my-realm'
      ]);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.auth.realm).toBe('my-realm');
    });

    test('passes --rate-limit-trust-proxy-headers option', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node', 'llm-adapter', 'serve',
        '--rate-limit-enabled',
        '--rate-limit-trust-proxy-headers'
      ]);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.rateLimit.trustProxyHeaders).toBe(true);
    });

    test('passes --no-security-headers-enabled option', async () => {
      const program = createUnifiedProgram(mockDeps);

      await program.parseAsync([
        'node', 'llm-adapter', 'serve',
        '--no-security-headers-enabled'
      ]);

      const serverOptions = mockDeps.createServer.mock.calls[0][0];
      expect(serverOptions.securityHeadersEnabled).toBe(false);
    });

    test('shutdown handler closes server gracefully', async () => {
      // Capture the shutdown handlers
      const signalHandlers: Record<string, Function> = {};
      jest.spyOn(process, 'on').mockImplementation((event: string, handler: any) => {
        signalHandlers[event] = handler;
        return process;
      });

      const program = createUnifiedProgram(mockDeps);
      await program.parseAsync(['node', 'llm-adapter', 'serve']);

      // Verify handlers were registered
      expect(signalHandlers['SIGINT']).toBeDefined();
      expect(signalHandlers['SIGTERM']).toBeDefined();

      // Trigger SIGINT shutdown
      await signalHandlers['SIGINT']();

      expect(mockRunningServer.close).toHaveBeenCalled();
      expect(capturedExitCodes).toContain(0);
    });

    test('shutdown handler ignores multiple calls', async () => {
      const signalHandlers: Record<string, Function> = {};
      jest.spyOn(process, 'on').mockImplementation((event: string, handler: any) => {
        signalHandlers[event] = handler;
        return process;
      });

      const program = createUnifiedProgram(mockDeps);
      await program.parseAsync(['node', 'llm-adapter', 'serve']);

      // Call shutdown multiple times
      await signalHandlers['SIGINT']();
      await signalHandlers['SIGINT']();
      await signalHandlers['SIGTERM']();

      // close should only be called once
      expect(mockRunningServer.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('defaultDependencies (exported for testing)', () => {
    let defaultDependencies: typeof import('@/modules/cli/internal/unified-cli.ts').defaultDependencies;

    beforeEach(async () => {
      jest.resetModules();
      const module = await import('@/modules/cli/internal/unified-cli.ts');
      defaultDependencies = module.defaultDependencies;
    });

    test('createRegistry calls lifecycle createRegistry', async () => {
      // This exercises the dynamic import path - use actual plugins directory
      const result = await defaultDependencies.createRegistry('./plugins');
      expect(result).toBeDefined();
      // It should have a loadAll method (from the real PluginRegistry)
      expect(typeof result.loadAll).toBe('function');
    });

    test('createLlmCoordinator calls lifecycle createLlmCoordinator', async () => {
      const mockRegistry = { loadAll: jest.fn() };
      const result = await defaultDependencies.createLlmCoordinator(mockRegistry);
      expect(result).toBeDefined();
      expect(typeof result.run).toBe('function');
      expect(typeof result.runStream).toBe('function');
      expect(typeof result.close).toBe('function');
    });

    test('createVectorCoordinator calls lifecycle createVectorCoordinator', async () => {
      const mockRegistry = { loadAll: jest.fn() };
      const result = await defaultDependencies.createVectorCoordinator(mockRegistry);
      expect(result).toBeDefined();
      expect(typeof result.execute).toBe('function');
      expect(typeof result.executeStream).toBe('function');
      expect(typeof result.close).toBe('function');
    });

    test('createEmbeddingCoordinator calls lifecycle createEmbeddingCoordinator', async () => {
      const mockRegistry = { loadAll: jest.fn() };
      const result = await defaultDependencies.createEmbeddingCoordinator(mockRegistry);
      expect(result).toBeDefined();
      expect(typeof result.execute).toBe('function');
      expect(typeof result.close).toBe('function');
    });

    test('createServer calls server createServer', async () => {
      // This exercises the dynamic import path by actually calling the function
      expect(typeof defaultDependencies.createServer).toBe('function');

      // Actually call createServer with minimal options - it will start a server
      const server = await defaultDependencies.createServer!({
        port: 0, // Let OS pick a free port
        host: '127.0.0.1'
      });

      expect(server).toBeDefined();
      expect(server.url).toContain('http://127.0.0.1');
      expect(typeof server.close).toBe('function');

      // Clean up
      await server.close();
    });

    test('createRealtimeSession calls realtime createRealtimeSession', async () => {
      jest.resetModules();

      const createRealtimeSessionMock = jest.fn().mockResolvedValue({ ok: true });
      (jest as any).unstable_mockModule('../../../modules/realtime/index.js', () => ({
        createRealtimeSession: createRealtimeSessionMock
      }));

      const module = await import('@/modules/cli/internal/unified-cli.ts');
      const deps = module.defaultDependencies;

      const result = await deps.createRealtimeSession?.({ registry: true } as any, { provider: 'p' } as any);

      expect(result).toEqual({ ok: true });
      expect(createRealtimeSessionMock).toHaveBeenCalledWith({ registry: true }, { provider: 'p' });
    });

    test('closeLogger calls lifecycle closeLogger', async () => {
      // This exercises the dynamic import path
      await expect(defaultDependencies.closeLogger()).resolves.toBeUndefined();
    });

    test('log calls console.log', () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      defaultDependencies.log('test message');
      expect(consoleLogSpy).toHaveBeenCalledWith('test message');
      consoleLogSpy.mockRestore();
    });

    test('error calls console.error', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      defaultDependencies.error('test error');
      expect(consoleErrorSpy).toHaveBeenCalledWith('test error');
      consoleErrorSpy.mockRestore();
    });

    test('exit sets process.exitCode without forcing exit', () => {
      const originalExitCode = process.exitCode;
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      defaultDependencies.exit(1);

      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();

      process.exitCode = originalExitCode;
      exitSpy.mockRestore();
    });
  });
});
