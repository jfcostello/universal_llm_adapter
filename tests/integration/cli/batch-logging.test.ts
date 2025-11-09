import http from 'http';
import fs from 'fs';
import path from 'path';
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { resolveFixture } from '@tests/helpers/paths.ts';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

function startCoordinatorServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          { message: { content: [{ type: 'text', text: 'ok' }] }, finish_reason: 'stop' }
        ]
      }));
    });
  });

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())))
        });
      } else {
        reject(new Error('Failed to bind test server'));
      }
    });
    server.on('error', reject);
  });
}

describe('CLI batch logging', () => {
  const pluginsDir = resolveFixture('plugins', 'basic');
  const spec = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    llmPriority: [{ provider: 'test-openai', model: 'stub-model' }],
    settings: { temperature: 0 },
    metadata: { correlationId: 'cli-batch-test' }
  };

  test('creates llm-batch-<id>.log when --batch-id is passed', async () => {
    await withTempCwd('cli-batch-logs', async (cwd) => {
      let networkAvailable = true;
      try {
        const probe = http.createServer((_, res) => res.end('ok'));
        await new Promise<void>((resolve, reject) => {
          probe.listen(0, '127.0.0.1', resolve);
          probe.on('error', reject);
        });
        probe.close();
      } catch (err: any) {
        if (err?.code === 'EPERM') networkAvailable = false;
        else throw err;
      }
      if (!networkAvailable) {
        console.warn('Skipping CLI batch logging test: bind not permitted');
        return;
      }

      const server = await startCoordinatorServer();
      const result = await runCoordinator({
        args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsDir, '--batch-id', 'cliBatch'],
        env: { ...process.env, TEST_LLM_ENDPOINT: server.url, LLM_ADAPTER_DISABLE_FILE_LOGS: '0' },
        cwd
      });
      await server.close();

      expect(result.code).toBe(0);

      const dir = path.join(cwd, 'logs', 'llm');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      expect(files).toContain('llm-batch-cliBatch.log');
    });
  });
});
