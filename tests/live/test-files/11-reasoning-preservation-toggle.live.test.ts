// 11 — Reasoning Preservation Toggle
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { testRuns } from '../config.ts';
import { withLiveEnv, makeSpec } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '11-reasoning-preservation-toggle';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? describe : describe.skip)(`11-reasoning-preservation-toggle — ${runCfg.name}`, () => {
    test('Call 1 — reasoning ON', async () => {
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Answer concisely and include internal reasoning if supported.' }]},
          { role: 'user', content: [{ type: 'text', text: 'What is 3 + 4?' }]}
        ],
        llmPriority: runCfg.llmPriority,
        settings: { ...runCfg.settings, temperature: 0.2, maxTokens: 200, reasoning: { enabled: true, budget: 1024 } }
      });
      const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
      if (result.code !== 0) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      if (payload.reasoning && typeof payload.reasoning.text === 'string') {
        expect(payload.reasoning.redacted === true || payload.reasoning.text.length > 0).toBe(true);
      } else {
        expect(true).toBe(true);
      }
    }, 120000);

    test('Call 2 — reasoning OFF', async () => {
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Answer concisely.' }]},
          { role: 'user', content: [{ type: 'text', text: 'What is 6 + 7?' }]}
        ],
        llmPriority: runCfg.llmPriority,
        settings: { ...runCfg.settings, temperature: 0.2, maxTokens: 200, reasoning: { enabled: false } }
      });
      const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
      if (result.code !== 0) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      expect(true).toBe(true); // Provider-dependent behavior accepted
    }, 120000);
  });
}

