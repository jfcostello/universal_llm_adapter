import { spawn } from 'child_process';
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

export function runCoordinator(options: CliRunOptions = {}): Promise<CliResult> {
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
