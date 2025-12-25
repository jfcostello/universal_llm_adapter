#!/usr/bin/env tsx
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { parseLaunchConfig, buildJestArgs } from './launcher/index.js';
import { maxWorkersDefault, realtimeTestRuns } from './config.ts';
import { getTestPathPatternsFromJestArgs, getMissingRequiredEnv } from './required-env.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');

function createRunId(prefix: string): string {
  // File-safe + stable, avoids characters that are invalid in env-derived IDs.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${stamp}`;
}

function createLiveBatchId(): string {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return [
    'live-test',
    now.getUTCFullYear(),
    pad2(now.getUTCMonth() + 1),
    pad2(now.getUTCDate()),
    pad2(now.getUTCHours()),
    pad2(now.getUTCMinutes()),
    pad2(now.getUTCSeconds())
  ].join('-');
}

async function spawnAndWait(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: any }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
}

async function buildDistOnce(): Promise<void> {
  const tsc = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const code = await spawnAndWait(process.execPath, [tsc, '--project', path.join(rootDir, 'tsconfig.json')], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit'
  });
  if (code !== 0) {
    throw new Error(`TypeScript build failed (exit ${code})`);
  }
}

async function startLiveServer(options: {
  env: NodeJS.ProcessEnv;
  batchId: string;
  enableRealtimeWs?: boolean;
  enableAuth?: boolean;
}): Promise<{ url: string; logPath: string; close: () => Promise<void> }> {
  const script = path.join(rootDir, 'dist', 'bin', 'cli.js');
  const logsDir = path.join(rootDir, 'tests', 'live', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const logPath = path.join(logsDir, `${new Date().toISOString().split('T')[0]}-server-process-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const child = spawn(
    process.execPath,
    [
      script,
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--plugins',
      './plugins',
      ...(options.enableAuth ? ['--auth-enabled'] : []),
      ...(options.enableRealtimeWs ? ['--realtime-enabled'] : [])
    ],
    {
      cwd: rootDir,
      env: {
        ...options.env,
        // Ensure server process behaves like a live run
        LLM_LIVE: '1',
        LLM_LIVE_TRANSPORT: 'server',
        // Ensure file logs are enabled for batch logging assertions
        LLM_ADAPTER_DISABLE_FILE_LOGS: '0',
        LLM_ADAPTER_BATCH_ID: options.batchId
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let resolved = false;
  let stdoutBuf = '';

  const tryParseUrl = (chunk: string): string | null => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^Server listening at (https?:\/\/\S+)$/);
      if (match) return match[1];
    }
    return null;
  };

  const url: string = await new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      const text = data.toString();
      logStream.write(text);
      const parsed = tryParseUrl(text);
      if (!resolved && parsed) {
        resolved = true;
        resolve(parsed);
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', (data: Buffer) => {
      logStream.write(data.toString());
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`Server exited before ready (exit ${code ?? 'unknown'})`));
      }
    });
  });

  const close = async () => {
    if (child.killed) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 5000);

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });

    logStream.end();
  };

  return { url, logPath, close };
}

function generateTestApiKey(): string {
  return `live_test_${crypto.randomBytes(24).toString('hex')}`;
}

async function main() {
  const { provider, maxWorkers, transport, passthrough } = parseLaunchConfig(
    process.argv.slice(2),
    process.env,
    { maxWorkersDefault }
  );

  const { nodeArgs, jestArgs } = buildJestArgs({ maxWorkers, passthrough });

  const hasCustomPattern = (passthrough || []).some(arg => String(arg).startsWith('--testPathPattern'));
  if (provider && !hasCustomPattern) {
    const idx = jestArgs.findIndex(arg => String(arg).startsWith('--testPathPattern='));
    if (idx !== -1) {
      // Provider-specific runs should not pull in realtime suite by default.
      jestArgs[idx] = '--testPathPattern=tests[\\\\/]live(?![\\\\/]test-files[\\\\/]20-realtime)';
    }
  }

  dotenv.config({ path: path.join(rootDir, '.env') });

  const baseEnv: NodeJS.ProcessEnv = { ...process.env, LLM_LIVE: '1' };
  if (provider) baseEnv.LLM_TEST_PROVIDERS = provider;
  const liveBatchId = createLiveBatchId();
  baseEnv.LLM_ADAPTER_BATCH_ID = liveBatchId;
  baseEnv.LLM_LIVE_BATCH_ID = liveBatchId;

  const testPathPatterns = getTestPathPatternsFromJestArgs(jestArgs);

  const selectedProviders =
    provider && String(provider).trim() !== ''
      ? [String(provider).trim()]
      : (baseEnv.LLM_TEST_PROVIDERS || '')
          .split(',')
          .map(p => p.trim())
          .filter(Boolean);

  const patterns = testPathPatterns.join(' ');
  const wantsAllLive = /\blive\b/i.test(patterns);
  const wantsEmbeddings = /\bembeddings\b|15-embeddings/i.test(patterns);
  const wantsVector =
    /\bvector\b|16-vector-store|17-vector-cli|18-vector-auto-inject|19-vector-search-locks/i.test(patterns);
  const wantsRealtime = testPathPatterns.some((pattern) => {
    const raw = String(pattern);
    // Provider-specific runs exclude realtime via a negative lookahead, but the literal
    // string "20-realtime" still appears in the pattern. Treat those as non-realtime.
    if (/\(\?!.*20-realtime/i.test(raw)) return false;
    return /\b20-realtime\b/i.test(raw) || /\brealtime\b/i.test(raw);
  });

  const expectsLlmSuites = wantsAllLive || (!wantsEmbeddings && !wantsVector && !wantsRealtime);

  baseEnv.LLM_LIVE_WANTS_REALTIME = wantsRealtime ? '1' : '0';

  const effectiveProviders =
    selectedProviders.length > 0
      ? selectedProviders
      : wantsRealtime
        ? Array.from(
            new Set(realtimeTestRuns.map(r => String((r as any)?.provider || '').trim()).filter(Boolean))
          )
        : expectsLlmSuites
          ? ['anthropic', 'openai-responses', 'openrouter', 'google']
          : [];

  const missingEnv = getMissingRequiredEnv({ selectedProviders: effectiveProviders, testPathPatterns, env: baseEnv });
  if (missingEnv.length > 0) {
    console.error(
      `Live tests require env var(s) that are missing/empty: ${missingEnv.join(', ')}. ` +
        `Refusing to run.`
    );
    process.exitCode = 1;
    return;
  }

  // Live suites invoke the built CLI entrypoint under `dist/` (and server mode runs `dist/bin/cli.js`),
  // so ensure `dist/` is up to date for *all* transports (cli/server/both) for deterministic results.
  await buildDistOnce();

  const runJest = async (extraEnv: NodeJS.ProcessEnv): Promise<number> => {
    return spawnAndWait(process.execPath, [...nodeArgs, ...jestArgs], {
      cwd: rootDir,
      env: { ...baseEnv, ...extraEnv },
      stdio: 'inherit'
    });
  };

  // Default behavior remains CLI-driven live tests
  if (transport === 'cli') {
    process.exitCode = await runJest({ LLM_LIVE_TRANSPORT: 'cli' });
    return;
  }

  // Server transport uses auth for all HTTP endpoints and (when enabled) realtime WS. Support
  // a dedicated server token and/or a separate realtime token, but keep them unified by default.
  const serverHttpApiKey =
    process.env.LLM_TEST_SERVER_API_KEY ??
    process.env.LLM_TEST_REALTIME_API_KEY ??
    generateTestApiKey();
  const serverRealtimeApiKey = process.env.LLM_TEST_REALTIME_API_KEY ?? serverHttpApiKey;
  const serverApiKeys = Array.from(new Set([serverHttpApiKey, serverRealtimeApiKey])).join(',');

  const commonJestEnv: NodeJS.ProcessEnv = {
    LLM_SKIP_TS_BUILD: '1',
    LLM_TEST_SERVER_API_KEY: serverHttpApiKey,
    LLM_TEST_REALTIME_API_KEY: serverRealtimeApiKey
  };

  if (transport === 'both') {
    const cliCode = await runJest({ ...commonJestEnv, LLM_LIVE_TRANSPORT: 'cli' });
    if (cliCode !== 0) {
      process.exitCode = cliCode;
      return;
    }
  }

  const batchId = liveBatchId;
  const server = await startLiveServer({
    env: {
      ...process.env,
      LLM_ADAPTER_API_KEYS: serverApiKeys,
      LLM_TEST_SERVER_API_KEY: serverHttpApiKey,
      LLM_TEST_REALTIME_API_KEY: serverRealtimeApiKey
    },
    batchId,
    // Live runs can include realtime tests even when not launched via `test:live:realtime`
    // (for example `npm run test:live:openrouter -- --transport=both`). Always enable realtime
    // WS routes for the live server process. Note: realtime WS requires auth.
    enableAuth: true,
    enableRealtimeWs: true
  });

  try {
    process.exitCode = await runJest({
      ...commonJestEnv,
      LLM_LIVE_TRANSPORT: 'server',
      LLM_TEST_SERVER_URL: server.url,
      LLM_LIVE_BATCH_ID: batchId,
      LLM_TEST_SERVER_PROCESS_LOG_PATH: server.logPath
    });
  } finally {
    await server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
