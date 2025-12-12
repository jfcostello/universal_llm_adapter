import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DIST_DIR } from './paths.ts';

export interface CliRunOptions {
  args?: string[];
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  logs: string[];
}

function getTransport(env: NodeJS.ProcessEnv | undefined): 'cli' | 'server' {
  const raw = String(env?.LLM_LIVE_TRANSPORT || process.env.LLM_LIVE_TRANSPORT || 'cli')
    .trim()
    .toLowerCase();
  return raw === 'server' ? 'server' : 'cli';
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1) {
    const next = args[idx + 1];
    return next ? String(next) : undefined;
  }

  const prefix = `${flag}=`;
  const eq = args.find(a => a.startsWith(prefix));
  if (!eq) return undefined;
  return String(eq.slice(prefix.length));
}

function findSpecFromArgs(options: CliRunOptions): { spec: any; args: string[] } {
  const args = [...(options.args ?? ['run'])];
  const cwd = options.cwd || process.cwd();

  const filePath = parseFlagValue(args, '--file');
  const specJson = parseFlagValue(args, '--spec');

  if (filePath) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const content = fs.readFileSync(resolved, 'utf-8');
    return { spec: JSON.parse(content), args };
  }

  if (specJson) {
    return { spec: JSON.parse(specJson), args };
  }

  if (options.stdin) {
    return { spec: JSON.parse(options.stdin), args };
  }

  throw new Error('No spec provided (expected --spec, --file, or stdin)');
}

function injectLiveMetadata(spec: any, env: NodeJS.ProcessEnv): { spec: any; correlationId: string } {
  const testFile = String(env.TEST_FILE || 'unknown-test');
  const testName = env.LLM_TEST_NAME ? String(env.LLM_TEST_NAME) : undefined;
  const rand = Math.random().toString(16).slice(2, 10);
  const correlationId = `${testFile}:${Date.now()}:${rand}`;

  const next = { ...(spec ?? {}) };
  next.metadata = {
    ...(next.metadata ?? {}),
    correlationId,
    testFile,
    ...(testName ? { testName } : {})
  };

  return { spec: next, correlationId };
}

async function readLogsForCorrelationId(options: {
  logPath?: string;
  correlationId: string;
  timeoutMs?: number;
}): Promise<string[]> {
  const logPath = options.logPath;
  if (!logPath) return [];

  const timeoutMs = options.timeoutMs ?? 2000;
  const start = Date.now();
  const needle = `"correlationId":"${options.correlationId}"`;

  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(logPath)) {
      await new Promise(res => setTimeout(res, 50));
      continue;
    }

    const text = fs.readFileSync(logPath, 'utf-8');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const matches = lines.filter(l => l.includes(needle));
    if (matches.length > 0) {
      return matches;
    }

    await new Promise(res => setTimeout(res, 50));
  }

  return [];
}

async function runCoordinatorViaServer(options: CliRunOptions): Promise<CliResult> {
  const env = options.env || process.env;
  const serverUrl = env.LLM_TEST_SERVER_URL;
  if (!serverUrl) {
    return {
      stdout: '',
      stderr: JSON.stringify({ error: 'Missing LLM_TEST_SERVER_URL for server transport' }),
      code: 1,
      logs: []
    };
  }

  const { spec: rawSpec, args } = findSpecFromArgs(options);
  const command = args[0] || 'run';

  if (command !== 'run' && command !== 'stream') {
    return {
      stdout: '',
      stderr: JSON.stringify({ error: `Unsupported command for server transport: ${command}` }),
      code: 1,
      logs: []
    };
  }

  const batchIdFlag = parseFlagValue(args, '--batch-id');
  const runWideBatchId = env.LLM_LIVE_BATCH_ID;
  if (batchIdFlag && runWideBatchId && String(batchIdFlag) !== String(runWideBatchId)) {
    return {
      stdout: '',
      stderr: JSON.stringify({
        error: 'batch_id_mismatch',
        message: 'Server transport uses a run-wide batch id; per-call --batch-id must match LLM_LIVE_BATCH_ID',
        expected: runWideBatchId,
        got: batchIdFlag
      }),
      code: 1,
      logs: []
    };
  }

  const { spec, correlationId } = injectLiveMetadata(rawSpec, env);

  try {
    if (command === 'run') {
      const res = await fetch(new URL('/run', serverUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec)
      });

      const text = await res.text();
      if (!res.ok) {
        const logs = await readLogsForCorrelationId({
          logPath: env.LLM_TEST_SERVER_PROCESS_LOG_PATH,
          correlationId
        });
        return { stdout: '', stderr: text, code: 1, logs };
      }

      const parsed = JSON.parse(text);
      const unwrapped = parsed?.type === 'response' ? parsed.data : parsed;

      const logs = await readLogsForCorrelationId({
        logPath: env.LLM_TEST_SERVER_PROCESS_LOG_PATH,
        correlationId
      });

      return { stdout: JSON.stringify(unwrapped), stderr: '', code: 0, logs };
    }

    // stream
    const res = await fetch(new URL('/stream', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec)
    });

    if (!res.ok) {
      const text = await res.text();
      const logs = await readLogsForCorrelationId({
        logPath: env.LLM_TEST_SERVER_PROCESS_LOG_PATH,
        correlationId
      });
      return { stdout: '', stderr: text, code: 1, logs };
    }

    const events: string[] = [];
    let buffer = '';

    for await (const chunk of res.body as any) {
      buffer += Buffer.from(chunk).toString('utf-8');

      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const lines = rawEvent.split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice('data:'.length).trimStart();
          if (!payload || payload === '[DONE]') continue;
          events.push(payload);
        }
      }
    }

    const logs = await readLogsForCorrelationId({
      logPath: env.LLM_TEST_SERVER_PROCESS_LOG_PATH,
      correlationId
    });

    return { stdout: events.join('\n'), stderr: '', code: 0, logs };
  } catch (error: any) {
    const logs = await readLogsForCorrelationId({
      logPath: env.LLM_TEST_SERVER_PROCESS_LOG_PATH,
      correlationId
    });
    return {
      stdout: '',
      stderr: JSON.stringify({ error: error?.message ?? String(error) }),
      code: 1,
      logs
    };
  }
}

export function runCoordinator(options: CliRunOptions = {}): Promise<CliResult> {
  if (getTransport(options.env) === 'server') {
    return runCoordinatorViaServer(options);
  }

  const script = path.join(DIST_DIR, 'llm_coordinator.js');
  const args = options.args ?? ['run'];

  return new Promise((resolve) => {
    // Use process.execPath to ensure we use the same Node.js executable running the tests
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd || DIST_DIR,
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      // Parse stdout: split by newlines, separate logs from response/stream events
      const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0);

      const responseLines: string[] = [];
      const logLines: string[] = [];

      // Iterate through lines and separate logs from response/events
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);

          // Log lines have type: "log"
          if (parsed.type === 'log') {
            logLines.push(line);
          }
          // Response has type: "response" - unwrap the data field
          else if (parsed.type === 'response') {
            // Unwrap: {type: "response", data: {...}} -> {...}
            const unwrapped = JSON.stringify(parsed.data);
            responseLines.push(unwrapped);
          }
          // Stream events and other types pass through as-is
          else {
            responseLines.push(line);
          }
        } catch {
          // Not JSON, treat as part of response
          responseLines.push(line);
        }
      }

      // Join response lines with newlines for stream output compatibility
      const responseOutput = responseLines.join('\n');

      resolve({
        stdout: responseOutput,
        stderr,
        code,
        logs: logLines
      });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
