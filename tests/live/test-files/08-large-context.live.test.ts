// 08 — Large Context
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, mergeSettings } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '08-large-context';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? test : test.skip)(`08-large-context — ${runCfg.name}`, async () => {
    const longA = 'A'.repeat(3000);
    const longB = 'B'.repeat(3000);
    const longC = 'C'.repeat(3000);
    const spec = makeSpec({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You must provide a brief summary of the conversation. Your response should include at least one sentence describing what you observed.' }]},
        { role: 'user', content: [{ type: 'text', text: `Turn1: ${longA}` }]},
        { role: 'assistant', content: [{ type: 'text', text: 'ack 1' }]},
        { role: 'user', content: [{ type: 'text', text: `Turn2: ${longB}` }]},
        { role: 'assistant', content: [{ type: 'text', text: 'ack 2' }]},
        { role: 'user', content: [{ type: 'text', text: `Turn3: ${longC}. Provide your summary now.` }]}
      ],
      llmPriority: runCfg.llmPriority,
      functionToolNames: [],
      settings: mergeSettings(runCfg.settings, { temperature: 0.2, maxTokens: 20000 })
    });
    const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    const text = String(payload.content?.[0]?.text ?? '');
    expect(text.trim().length).toBeGreaterThan(0);
  }, 120000);
}

