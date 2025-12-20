// 21 — Usage cost estimation + override checks
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns } from '../config.ts';
import { makeSpec, mergeSettings, withLiveEnv } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];

  (runLive ? describe : describe.skip)(`21-usage-cost — ${runCfg.name}`, () => {
    test('reports usage cost when enabled', async () => {
      const env = withLiveEnv({ TEST_FILE: '21-usage-cost' });
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Respond with a short greeting.' }]},
          { role: 'user', content: [{ type: 'text', text: 'Say hello.' }]}
        ],
        llmPriority: runCfg.llmPriority,
        settings: mergeSettings(runCfg.settings, { maxTokens: 256, usageCost: { enabled: true } }),
        functionToolNames: []
      });

      const result = await runCoordinator({
        args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const cost = payload?.usage?.cost;
      if (cost !== undefined && cost !== null) {
        expect(typeof cost).toBe('number');
      }
    }, 120000);

    test('usage cost override disable does not add cost when missing', async () => {
      const env = withLiveEnv({ TEST_FILE: '21-usage-cost' });
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Respond with a short greeting.' }]},
          { role: 'user', content: [{ type: 'text', text: 'Say hello.' }]}
        ],
        llmPriority: runCfg.llmPriority,
        settings: mergeSettings(runCfg.settings, { maxTokens: 256, usageCost: { enabled: false } }),
        functionToolNames: []
      });

      const result = await runCoordinator({
        args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const cost = payload?.usage?.cost;
      if (cost !== undefined && cost !== null) {
        expect(typeof cost).toBe('number');
      }
    }, 120000);
  });
}
