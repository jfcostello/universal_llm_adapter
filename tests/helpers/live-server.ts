import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export async function startLiveServerProcess(options: {
  rootDir?: string;
  pluginsPath?: string;
  env: NodeJS.ProcessEnv;
  batchId: string;
  enableRealtimeWs?: boolean;
  enableAuth?: boolean;
  enableFilepathDocs?: boolean;
  filepathDocsAllowedRoots?: string[];
}): Promise<{ url: string; logPath: string; close: () => Promise<void> }> {
  const rootDir = options.rootDir ?? process.cwd();
  const script = path.join(rootDir, 'dist', 'bin', 'cli.js');
  const logsDir = path.join(rootDir, 'tests', 'live', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const logPath = path.join(logsDir, `${new Date().toISOString().split('T')[0]}-server-process-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const filepathRoots =
    options.enableFilepathDocs === true
      ? (options.filepathDocsAllowedRoots && options.filepathDocsAllowedRoots.length > 0
          ? options.filepathDocsAllowedRoots
          : [rootDir])
      : [];

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
      options.pluginsPath ?? './plugins',
      ...(options.enableAuth ? ['--auth-mode', 'apiKey'] : []),
      ...(options.enableFilepathDocs ? ['--policy-documents-filepath-enabled'] : []),
      ...filepathRoots.flatMap(root => ['--policy-documents-filepath-root', root]),
      ...(options.enableRealtimeWs ? ['--realtime-enabled'] : [])
    ],
    {
      cwd: rootDir,
      env: {
        ...options.env,
        // Ensure server process behaves like a live run
        LLM_LIVE: '1',
        LLM_LIVE_TRANSPORT: 'server',
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
