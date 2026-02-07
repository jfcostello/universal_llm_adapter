import type { ProcessRouteManifest } from '../../../../../kernel/index.js';
import type { ToolContext } from './types.js';

export async function invokeCommand(options: {
  route: ProcessRouteManifest;
  ctx: ToolContext;
  signal?: AbortSignal;
  spawnProcess: (command: string, args: string[], spawnOptions: any) => any;
}): Promise<any> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(options.route.invoke.env || {}) };

    const proc = options.spawnProcess(options.route.invoke.command!, options.route.invoke.args || [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const killProcess = () => {
      try {
        (proc as any).kill?.('SIGKILL');
      } catch {
        try {
          (proc as any).kill?.();
        } catch {
          // ignore
        }
      }
    };

    const onAbort = () => {
      killProcess();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: any) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: any) => {
      stderr += data.toString();
    });

    proc.on('close', (code: any) => {
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      if (code !== 0) {
        reject(new Error(`Command exited with code ${code}: ${stderr}`));
      } else {
        try {
          const result = stdout ? JSON.parse(stdout) : { result: null };
          resolve(result);
        } catch (e) {
          reject(new Error(`Invalid JSON output: ${stdout}`));
        }
      }
    });

    const ignoreStdinError = (_err: unknown) => {};
    if (typeof (proc.stdin as any)?.on === 'function') {
      proc.stdin.on('error', ignoreStdinError);
    }

    try {
      proc.stdin.write(JSON.stringify(options.ctx) + '\n');
    } catch (err) {
      ignoreStdinError(err);
    }

    try {
      proc.stdin.end();
    } catch (err) {
      ignoreStdinError(err);
    }
  });
}
