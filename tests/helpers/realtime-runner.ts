import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DIST_DIR } from './paths.ts';

type Transport = 'cli' | 'server';

export interface RealtimeAudioFrame {
  format: string;
  sampleRateHz: number;
  channels: 1 | 2;
  dataBase64: string;
  timestampMs?: number;
}

export type RealtimeClientMessage =
  | { type: 'open'; protocolVersion: 1; spec: any }
  | { type: 'send_text'; text: string; role?: 'system' | 'user' }
  | { type: 'send_audio'; frame: RealtimeAudioFrame }
  | { type: 'commit' }
  | { type: 'interrupt'; reason?: string }
  | { type: 'close' };

export type RealtimeServerEnvelope =
  | { type: 'event'; event: any }
  | { type: 'error'; error: { message: string; code?: string } };

export interface RealtimeScenarioStep {
  type:
    | 'send_text'
    | 'send_audio_file'
    | 'commit'
    | 'interrupt'
    | 'wait_for_event'
    | 'sleep_ms'
    | 'close';
  text?: string;
  role?: 'system' | 'user';
  filePath?: string;
  frameFormat?: string;
  sampleRateHz?: number;
  channels?: 1 | 2;
  chunkMs?: number;
  reason?: string;
  eventType?: string;
  timeoutMs?: number;
  ms?: number;
}

export interface RunRealtimeScenarioOptions {
  pluginsPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  authHeaderName?: string;
  authToken?: string;
  spec: any;
  steps: RealtimeScenarioStep[];
  timeoutMs?: number;
}

export interface RunRealtimeScenarioResult {
  code: number | null;
  stdout: string;
  stderr: string;
  envelopes: RealtimeServerEnvelope[];
}

function getTransport(env: NodeJS.ProcessEnv | undefined): Transport {
  const raw = String(env?.LLM_LIVE_TRANSPORT || process.env.LLM_LIVE_TRANSPORT || 'cli')
    .trim()
    .toLowerCase();
  return raw === 'server' ? 'server' : 'cli';
}

function getUnifiedCliScript(): string {
  return path.join(DIST_DIR, 'bin', 'cli.js');
}

function toWsUrl(serverUrl: string, pathname: string): string {
  const url = new URL(serverUrl);
  const isHttps = url.protocol === 'https:';
  url.protocol = isHttps ? 'wss:' : 'ws:';
  url.pathname = pathname;
  url.search = '';
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkBytesForMs(format: string, sampleRateHz: number, channels: number, chunkMs: number): number {
  const ms = Math.max(1, chunkMs);
  const frames = Math.max(1, Math.floor((sampleRateHz * ms) / 1000));
  const bytesPerSample = format === 'pcm16' ? 2 : 1;
  return frames * channels * bytesPerSample;
}

async function readAudioFileAsFrames(options: {
  filePath: string;
  format: string;
  sampleRateHz: number;
  channels: 1 | 2;
  chunkMs: number;
}): Promise<RealtimeAudioFrame[]> {
  const bytes = fs.readFileSync(options.filePath);
  const chunkBytes = chunkBytesForMs(options.format, options.sampleRateHz, options.channels, options.chunkMs);

  const frames: RealtimeAudioFrame[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
    frames.push({
      format: options.format,
      sampleRateHz: options.sampleRateHz,
      channels: options.channels,
      dataBase64: Buffer.from(slice).toString('base64')
    });
  }
  return frames;
}

class EnvelopeQueue {
  private queue: RealtimeServerEnvelope[] = [];
  private resolvers: Array<(value: RealtimeServerEnvelope) => void> = [];

  push(envelope: RealtimeServerEnvelope) {
    const next = this.resolvers.shift();
    if (next) next(envelope);
    else this.queue.push(envelope);
  }

  async next(timeoutMs: number): Promise<RealtimeServerEnvelope> {
    if (this.queue.length > 0) return this.queue.shift()!;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.resolvers.indexOf(resolve);
        if (idx >= 0) this.resolvers.splice(idx, 1);
        reject(new Error(`Timed out waiting for realtime envelope (${timeoutMs}ms)`));
      }, timeoutMs);
      this.resolvers.push((v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }
}

async function runViaCli(options: RunRealtimeScenarioOptions): Promise<RunRealtimeScenarioResult> {
  const script = getUnifiedCliScript();
  const args = ['realtime', '--plugins', options.pluginsPath ?? './plugins'];

  const child = spawn(process.execPath, [script, ...args], {
    cwd: options.cwd || DIST_DIR,
    env: options.env || process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const envelopes: RealtimeServerEnvelope[] = [];
  const q = new EnvelopeQueue();
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => {
    const chunk = data.toString();
    stdout += chunk;
    const lines = chunk.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RealtimeServerEnvelope;
        if (parsed && (parsed.type === 'event' || parsed.type === 'error')) {
          envelopes.push(parsed);
          q.push(parsed);
        }
      } catch {
        // ignore non-json noise
      }
    }
  });

  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  const writeLine = async (msg: RealtimeClientMessage) => {
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(msg)}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  const timeoutMs = options.timeoutMs ?? 30000;
  await writeLine({ type: 'open', protocolVersion: 1, spec: options.spec });

  // Wait for ready or error
  while (true) {
    const env = await q.next(timeoutMs);
    if (env.type === 'error') throw new Error(env.error?.message ?? 'Realtime CLI error');
    if (env.type === 'event' && env.event?.type === 'ready') break;
  }

  for (const step of options.steps) {
    switch (step.type) {
      case 'send_text': {
        await writeLine({
          type: 'send_text',
          text: String(step.text ?? ''),
          role: step.role ?? 'user'
        });
        break;
      }
      case 'send_audio_file': {
        if (!step.filePath) throw new Error('send_audio_file missing filePath');
        const frames = await readAudioFileAsFrames({
          filePath: step.filePath,
          format: String(step.frameFormat ?? 'pcm16'),
          sampleRateHz: Number(step.sampleRateHz ?? 24000),
          channels: (step.channels ?? 1) as 1 | 2,
          chunkMs: Number(step.chunkMs ?? 20)
        });
        for (const frame of frames) {
          await writeLine({ type: 'send_audio', frame });
        }
        break;
      }
      case 'commit':
        await writeLine({ type: 'commit' });
        break;
      case 'interrupt':
        await writeLine({ type: 'interrupt', reason: step.reason });
        break;
      case 'wait_for_event': {
        const want = String(step.eventType ?? '').trim();
        if (!want) throw new Error('wait_for_event missing eventType');
        const stepTimeoutMs = Number(step.timeoutMs ?? timeoutMs);
        while (true) {
          const env = await q.next(stepTimeoutMs);
          if (env.type === 'error') throw new Error(env.error?.message ?? 'Realtime CLI error');
          if (env.type === 'event' && env.event?.type === want) break;
        }
        break;
      }
      case 'sleep_ms':
        await sleep(Number(step.ms ?? 0));
        break;
      case 'close':
        await writeLine({ type: 'close' });
        break;
    }
  }

  // Always close stdin so the child can exit.
  try {
    child.stdin.end();
  } catch {}

  const code: number | null = await new Promise(resolve => child.on('close', resolve));

  return { code, stdout, stderr, envelopes };
}

async function runViaServer(options: RunRealtimeScenarioOptions): Promise<RunRealtimeScenarioResult> {
  const env = options.env || process.env;
  const serverUrl = options.serverUrl || env.LLM_TEST_SERVER_URL;
  if (!serverUrl) {
    return {
      code: 1,
      stdout: '',
      stderr: JSON.stringify({ error: 'Missing server URL (expected serverUrl or LLM_TEST_SERVER_URL)' }),
      envelopes: []
    };
  }

  const authHeaderName = options.authHeaderName ?? 'x-api-key';
  const authToken = options.authToken ?? env.LLM_TEST_REALTIME_API_KEY;
  const wsUrl = toWsUrl(serverUrl, '/realtime/ws');

  const WS: any = (globalThis as any).WebSocket;
  if (!WS) {
    return {
      code: 1,
      stdout: '',
      stderr: JSON.stringify({ error: 'WebSocket not available in this Node runtime' }),
      envelopes: []
    };
  }

  const headers = authToken ? { [authHeaderName]: authToken } : undefined;

  const ws = new WS(wsUrl, [], headers ? { headers } : undefined);
  const envelopes: RealtimeServerEnvelope[] = [];
  const q = new EnvelopeQueue();
  let stdout = '';
  let stderr = '';

  const timeoutMs = options.timeoutMs ?? 30000;

  const ready = await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${wsUrl}`)), timeoutMs);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (err: any) => {
      clearTimeout(timer);
      reject(err);
    };
  });
  void ready;

  ws.onmessage = (evt: any) => {
    const text = typeof evt.data === 'string' ? evt.data : Buffer.from(evt.data).toString('utf-8');
    stdout += `${text}\n`;
    try {
      const parsed = JSON.parse(text) as RealtimeServerEnvelope;
      if (parsed && (parsed.type === 'event' || parsed.type === 'error')) {
        envelopes.push(parsed);
        q.push(parsed);
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    // no-op
  };

  const send = (msg: RealtimeClientMessage) => ws.send(JSON.stringify(msg));

  send({ type: 'open', protocolVersion: 1, spec: options.spec });

  while (true) {
    const env = await q.next(timeoutMs);
    if (env.type === 'error') throw new Error(env.error?.message ?? 'Realtime WS error');
    if (env.type === 'event' && env.event?.type === 'ready') break;
  }

  for (const step of options.steps) {
    switch (step.type) {
      case 'send_text':
        send({ type: 'send_text', text: String(step.text ?? ''), role: step.role ?? 'user' });
        break;
      case 'send_audio_file': {
        if (!step.filePath) throw new Error('send_audio_file missing filePath');
        const frames = await readAudioFileAsFrames({
          filePath: step.filePath,
          format: String(step.frameFormat ?? 'pcm16'),
          sampleRateHz: Number(step.sampleRateHz ?? 24000),
          channels: (step.channels ?? 1) as 1 | 2,
          chunkMs: Number(step.chunkMs ?? 20)
        });
        for (const frame of frames) {
          send({ type: 'send_audio', frame });
        }
        break;
      }
      case 'commit':
        send({ type: 'commit' });
        break;
      case 'interrupt':
        send({ type: 'interrupt', reason: step.reason });
        break;
      case 'wait_for_event': {
        const want = String(step.eventType ?? '').trim();
        if (!want) throw new Error('wait_for_event missing eventType');
        const stepTimeoutMs = Number(step.timeoutMs ?? timeoutMs);
        while (true) {
          const env = await q.next(stepTimeoutMs);
          if (env.type === 'error') throw new Error(env.error?.message ?? 'Realtime WS error');
          if (env.type === 'event' && env.event?.type === want) break;
        }
        break;
      }
      case 'sleep_ms':
        await sleep(Number(step.ms ?? 0));
        break;
      case 'close':
        send({ type: 'close' });
        break;
    }
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 250);
    try {
      ws.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.close();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });

  return { code: 0, stdout, stderr, envelopes };
}

export async function runRealtimeScenario(options: RunRealtimeScenarioOptions): Promise<RunRealtimeScenarioResult> {
  if (getTransport(options.env) === 'server') {
    return runViaServer(options);
  }
  return runViaCli(options);
}
