#!/usr/bin/env tsx
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { parseLaunchConfig, buildJestArgs } from './launcher/index.js';
import { maxWorkersDefault } from './config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');

function createRunId(prefix: string): string {
  // File-safe + stable, avoids characters that are invalid in env-derived IDs.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${stamp}`;
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
}): Promise<{ url: string; logPath: string; close: () => Promise<void> }> {
  const script = path.join(rootDir, 'dist', 'llm_coordinator.js');
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
      './plugins'
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

async function main() {
  const { provider, maxWorkers, transport, passthrough } = parseLaunchConfig(
    process.argv.slice(2),
    process.env,
    { maxWorkersDefault }
  );

  const { nodeArgs, jestArgs } = buildJestArgs({ maxWorkers, passthrough });

  const baseEnv: NodeJS.ProcessEnv = { ...process.env, LLM_LIVE: '1' };
  if (provider) baseEnv.LLM_TEST_PROVIDERS = provider;

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

  // Server-based transports require dist/ for running the server outside Jest.
  dotenv.config({ path: path.join(rootDir, '.env') });
  await buildDistOnce();

  const commonJestEnv = { LLM_SKIP_TS_BUILD: '1' };

  if (transport === 'both') {
    const cliCode = await runJest({ ...commonJestEnv, LLM_LIVE_TRANSPORT: 'cli' });
    if (cliCode !== 0) {
      process.exitCode = cliCode;
      return;
    }
  }

  const batchId = createRunId('live-server');
  const server = await startLiveServer({ env: process.env, batchId });

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
