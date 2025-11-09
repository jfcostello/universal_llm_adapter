import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { llmPriority, defaultSettings } from './config.ts';

const runLive = process.env.LLM_LIVE === '1';

(runLive ? test : test.skip)('live provider responds with deterministic output', async () => {
  const spec = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Reply exactly with: OK' }]
      }
    ],
    llmPriority,
    settings: {
      ...defaultSettings
    }
  };

  const result = await runCoordinator({
    args: ['run', '--spec', JSON.stringify(spec), '--plugins', './plugins'],
    cwd: process.cwd(),
    env: process.env
  });

  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout.trim());
  const text = payload.content?.[0]?.text || '';
  expect(text.trim()).toBe('OK');
});
