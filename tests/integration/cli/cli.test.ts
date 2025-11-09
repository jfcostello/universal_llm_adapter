import http from 'http';
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { ROOT_DIR, resolveFixture } from '@tests/helpers/paths.ts';

function startCoordinatorServer() {
  let callCount = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};

      if (payload.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream'
        });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (callCount === 0) {
        callCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: 'text', text: 'tool required' }
                ],
                tool_calls: [
                  {
                    id: 'call-1',
                    function: {
                      name: 'echo.text',
                      arguments: JSON.stringify({ text: 'cli' })
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: 'text', text: 'final response' }
                ]
              },
              finish_reason: 'stop'
            }
          ]
        }));
      }
    });
  });

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          close: () =>
            new Promise<void>((res, rej) => {
              server.close(err => (err ? rej(err) : res()));
            })
        });
      } else {
        reject(new Error('Failed to start server'));
      }
    });
    server.on('error', reject);
  });
}

const baseSpec = {
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'use tool' }
      ]
    }
  ],
  llmPriority: [
    {
      provider: 'test-openai',
      model: 'stub-model'
    }
  ],
  settings: {
    temperature: 0,
    toolCountdownEnabled: true,
    toolFinalPromptEnabled: true,
    maxToolIterations: 1
  },
  functionToolNames: ['echo.text'],
  metadata: {
    correlationId: 'cli-test'
  }
};

let networkAvailable = true;

beforeAll(async () => {
  const probe = http.createServer((_, res) => res.end('ok'));
  try {
    await new Promise<void>((resolve, reject) => {
      probe.listen(0, '127.0.0.1', resolve);
      probe.on('error', reject);
    });
  } catch (error: any) {
    if (error?.code === 'EPERM') {
      networkAvailable = false;
    } else {
      throw error;
    }
  } finally {
    probe.close();
  }
});

describe('CLI llm-coordinator', () => {
  const pluginsDir = resolveFixture('plugins', 'basic');
  const specPath = resolveFixture('specs', 'simple.json');

  test('run command executes spec and prints JSON', async () => {
    if (!networkAvailable) {
      console.warn('Skipping CLI network test: binding not permitted');
      return;
    }
    const server = await startCoordinatorServer();
    const specString = JSON.stringify(baseSpec);

    const result = await runCoordinator({
      args: ['run', '--spec', specString, '--plugins', pluginsDir],
      env: { TEST_LLM_ENDPOINT: server.url },
      cwd: ROOT_DIR
    });

    await server.close();

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.content[0].text).toBe('final response');
    expect(parsed.raw.toolResults[0].result.echoed).toBe('cli');
  });

  test('stream command emits streaming events', async () => {
    if (!networkAvailable) {
      console.warn('Skipping CLI network test: binding not permitted');
      return;
    }
    const server = await startCoordinatorServer();
    const specString = JSON.stringify({ ...baseSpec, settings: { temperature: 0 } });

    const result = await runCoordinator({
      args: ['stream', '--spec', specString, '--plugins', pluginsDir],
      env: { TEST_LLM_ENDPOINT: server.url },
      cwd: ROOT_DIR
    });

    await server.close();

    const lines = result.stdout.trim().split('\n');
    // Stream now emits {type: "delta", content: "..."} and {type: "DONE"}
    expect(lines[0]).toContain('"type":"delta"');
    expect(lines[0]).toContain('"content":"Hi"');
    expect(lines[lines.length - 1]).toContain('"type":"DONE"');
  });

  test('run command loads spec from file and stdin', async () => {
    if (!networkAvailable) {
      console.warn('Skipping CLI network test: binding not permitted');
      return;
    }
    const server = await startCoordinatorServer();
    const fileResult = await runCoordinator({
      args: ['run', '--file', specPath, '--plugins', pluginsDir, '--pretty'],
      env: { TEST_LLM_ENDPOINT: server.url },
      cwd: ROOT_DIR
    });
    expect(fileResult.code).toBe(0);

    const specJson = JSON.stringify(baseSpec);
    const stdinResult = await runCoordinator({
      args: ['run', '--plugins', pluginsDir],
      env: { TEST_LLM_ENDPOINT: server.url },
      cwd: ROOT_DIR,
      stdin: specJson
    });
    await server.close();

    expect(stdinResult.code).toBe(0);
    expect(JSON.parse(stdinResult.stdout).content[0].text).toContain('final');
  });

  test('invalid spec surfaces CLI error', async () => {
    if (!networkAvailable) {
      console.warn('Skipping CLI network test: binding not permitted');
      return;
    }
    const result = await runCoordinator({
      args: ['run', '--spec', '{bad json}', '--plugins', pluginsDir],
      cwd: ROOT_DIR
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('error');
  });
});
