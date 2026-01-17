import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runCoordinator, runVectorCoordinator } from '@tests/helpers/node-cli.ts';
import { startLiveServerProcess } from '@tests/helpers/live-server.ts';
import { resolveFixture } from '@tests/helpers/paths.ts';
import { withLiveEnv } from '@tests/helpers/live.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '00-validation-and-plugin-loading';
const DIST_CLI = path.join(process.cwd(), 'dist', 'bin', 'cli.js');

function lastNonEmptyLine(text: string): string {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function parseJsonLine(text: string): any {
  const line = lastNonEmptyLine(text);
  return JSON.parse(line);
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_CLI, ...args], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('Invalid JSON input is rejected with a structured error + stable code', async () => {
    if (String(process.env.LLM_LIVE_TRANSPORT || '').trim().toLowerCase() === 'server') {
      const baseUrl = String(process.env.LLM_TEST_SERVER_URL || '').trim();
      expect(baseUrl).toBeTruthy();

      const apiKey = String(process.env.LLM_TEST_SERVER_API_KEY || '').trim();

      // Prove server auth is enforced (and runs before body parsing) by sending invalid JSON without auth.
      const unauthRes = await fetch(new URL('/run', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{'
      });
      expect(unauthRes.status).toBe(401);
      const unauthBody = await unauthRes.json();
      expect(unauthBody?.type).toBe('error');
      expect(unauthBody?.error?.code).toBe('unauthorized');

      const res = await fetch(new URL('/run', baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {})
        },
        body: '{'
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body?.type).toBe('error');
      expect(body?.error?.code).toBe('invalid_json');
      return;
    }

    const env = withLiveEnv({ TEST_FILE });
    const result = await runCli(['run', '--spec', '{', '--plugins', './plugins'], env);
    expect(result.code).not.toBe(0);

    const body = parseJsonLine(result.stderr);
    expect(body?.type).toBe('error');
    expect(body?.error?.code).toBe('invalid_json');
  }, 60_000);

  test('Structurally invalid specs are rejected with validation details', async () => {
    const result = await runCoordinator({
      args: ['run', '--spec', JSON.stringify({}), '--plugins', './plugins'],
      cwd: process.cwd(),
      env: withLiveEnv({ TEST_FILE })
    });
    expect(result.code).not.toBe(0);
    const body = parseJsonLine(result.stderr);
    expect(body?.type).toBe('error');
    expect(body?.error?.code).toBe('validation_error');
    expect(Array.isArray(body?.error?.details) && body.error.details.length > 0).toBe(true);
  }, 60_000);

  test('Unknown operations return a structured error result (vector)', async () => {
    const result = await runVectorCoordinator({
      args: [
        'run',
        '--spec',
        JSON.stringify({
          operation: 'not_a_real_operation',
          store: 'does-not-matter'
        }),
        '--plugins',
        './plugins'
      ],
      cwd: process.cwd(),
      env: withLiveEnv({ TEST_FILE })
    });
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout.trim());
    expect(body?.success).toBe(false);
    expect(String(body?.error || '')).toContain('Unknown operation');
  }, 60_000);

  test('Invalid settings shapes are rejected with structured validation errors', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const spec = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: runCfg.llmPriority,
      settings: 'not-an-object'
    };

    const result = await runCoordinator({
      args: ['run', '--spec', JSON.stringify(spec), '--plugins', './plugins'],
      cwd: process.cwd(),
      env: withLiveEnv({ TEST_FILE })
    });
    expect(result.code).not.toBe(0);

    const body = parseJsonLine(result.stderr);
    expect(body?.type).toBe('error');
    expect(body?.error?.code).toBe('validation_error');
  }, 60_000);

  test('Error outputs do not leak secrets (stderr + live logs)', async () => {
    const secret = `SECRET_${Date.now()}_SHOULD_NOT_LEAK`;

    const result = await runCoordinator({
      args: ['run', '--spec', JSON.stringify({ settings: { apiKey: secret } }), '--plugins', './plugins'],
      cwd: process.cwd(),
      env: withLiveEnv({ TEST_FILE })
    });
    expect(result.code).not.toBe(0);

    expect(result.stderr).not.toContain(secret);
    expect(result.logs.join('\n')).not.toContain(secret);
  }, 60_000);

  test('Malformed plugin config fixture fails fast with a structured error naming the bad file', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const pluginsPath = resolveFixture('plugins', 'malformed-config');
    const spec = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: runCfg.llmPriority,
      settings: {}
    };

    const result = await runCli(
      ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
      withLiveEnv({
        TEST_FILE,
        LLM_LIVE_TRANSPORT: 'cli',
        LLM_ADAPTER_VALIDATE_PLUGINS: '1'
      })
    );

    expect(result.code).not.toBe(0);
    const body = parseJsonLine(result.stderr);
    expect(body?.type).toBe('error');
    expect(String(body?.error?.message || '')).toContain('malformed.json');
    expect(body?.error?.code).toBe('invalid_json');
  }, 60_000);

  test('Plugin config references missing implementation and fails fast with a structured error', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const pluginsPath = resolveFixture('plugins', 'missing-implementation');
    const spec = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: runCfg.llmPriority,
      settings: {}
    };

    const result = await runCli(
      ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
      withLiveEnv({
        TEST_FILE,
        LLM_LIVE_TRANSPORT: 'cli',
        LLM_ADAPTER_VALIDATE_PLUGINS: '1'
      })
    );

    expect(result.code).not.toBe(0);
    const body = parseJsonLine(result.stderr);
    expect(body?.type).toBe('error');
    expect(String(body?.error?.message || '')).toContain('No compat module found');
  }, 60_000);

  test('Invalid document base64 is rejected with structured validation error', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const spec = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: 'not base64!!!' },
              mimeType: 'application/pdf',
              filename: 'x.pdf'
            }
          ]
        }
      ],
      llmPriority: runCfg.llmPriority,
      settings: runCfg.settings
    };

    const result = await runCoordinator({
      args: ['run', '--spec', JSON.stringify(spec), '--plugins', './plugins'],
      cwd: process.cwd(),
      env: withLiveEnv({ TEST_FILE })
    });

    expect(result.code).not.toBe(0);
    const body = parseJsonLine(result.stderr);
    expect(body?.type).toBe('error');
    expect(body?.error?.code).toBe('validation_error');
  }, 60_000);

  test('Unsupported document mimeType is rejected with a structured error', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const spec = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: 'AA==' },
              mimeType: 'application/x-not-supported',
              filename: 'x.bin'
            }
          ]
        }
      ],
      llmPriority: runCfg.llmPriority,
      settings: runCfg.settings
    };

    const result = await runCoordinator({
      args: ['run', '--spec', JSON.stringify(spec), '--plugins', './plugins'],
      cwd: process.cwd(),
      env: withLiveEnv({ TEST_FILE })
    });

    expect(result.code).not.toBe(0);
    const body = parseJsonLine(result.stderr);
    expect(body?.type).toBe('error');
    expect(body?.error?.code).toBe('unsupported_mime_type');
  }, 60_000);

  test('Retrieval misconfiguration surfaces a structured config error (no embedding calls)', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const pluginsPath = resolveFixture('plugins', 'vector-misconfig');
    const spec = {
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] }],
      llmPriority: runCfg.llmPriority,
      settings: runCfg.settings,
      vectorContext: {
        mode: 'auto',
        stores: ['memory'],
        topK: 1
      }
    };

    const transport = String(process.env.LLM_LIVE_TRANSPORT || '').trim().toLowerCase();
    if (transport === 'server') {
      const batchId = `live-vector-misconfig-${Date.now()}`;
      const server = await startLiveServerProcess({
        pluginsPath,
        batchId,
        env: withLiveEnv({ TEST_FILE })
      });

      try {
        const result = await runCoordinator({
          args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
          cwd: process.cwd(),
          env: withLiveEnv({
            TEST_FILE,
            LLM_LIVE_TRANSPORT: 'server',
            LLM_TEST_SERVER_URL: server.url
          })
        });

        expect(result.code).not.toBe(0);
        const body = parseJsonLine(result.stderr);
        expect(body?.type).toBe('error');
        expect(body?.error?.code).toBe('config_error');
        return;
      } finally {
        await server.close();
      }
    }

    const result = await runCoordinator({
      args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
      cwd: process.cwd(),
      env: withLiveEnv({ TEST_FILE })
    });
    expect(result.code).not.toBe(0);
    const body = parseJsonLine(result.stderr);
    expect(body?.type).toBe('error');
    expect(body?.error?.code).toBe('config_error');
  }, 90_000);

  test('File logging disabled via env creates no adapter batch log files', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const pluginsPath = resolveFixture('plugins', 'vector-misconfig');
    const batchId = `live-disable-file-logs-${Date.now()}`;
    const expectedLogPath = path.join(process.cwd(), 'logs', `adapter-batch-${batchId}.log`);
    try {
      fs.unlinkSync(expectedLogPath);
    } catch {}

    const spec = {
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      llmPriority: runCfg.llmPriority,
      settings: runCfg.settings,
      vectorContext: { mode: 'auto', stores: ['memory'], topK: 1 }
    };

    const transport = String(process.env.LLM_LIVE_TRANSPORT || '').trim().toLowerCase();
    if (transport === 'server') {
      const server = await startLiveServerProcess({
        pluginsPath,
        batchId,
        env: withLiveEnv({
          TEST_FILE,
          LLM_ADAPTER_DISABLE_FILE_LOGS: '1',
          LLM_ADAPTER_BATCH_ID: batchId
        })
      });

      try {
        const result = await runCoordinator({
          args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
          cwd: process.cwd(),
          env: withLiveEnv({
            TEST_FILE,
            LLM_LIVE_TRANSPORT: 'server',
            LLM_TEST_SERVER_URL: server.url
          })
        });

        expect(result.code).not.toBe(0);
      } finally {
        await server.close();
      }
    } else {
      const result = await runCoordinator({
        args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env: withLiveEnv({
          TEST_FILE,
          LLM_ADAPTER_DISABLE_FILE_LOGS: '1',
          LLM_ADAPTER_BATCH_ID: batchId
        })
      });
      expect(result.code).not.toBe(0);
    }

    expect(fs.existsSync(expectedLogPath)).toBe(false);
  }, 120_000);
});
