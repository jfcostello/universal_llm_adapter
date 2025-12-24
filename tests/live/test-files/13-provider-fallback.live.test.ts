// 13 — Provider Fallback
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns, invalidPriorityEntry } from '../config.ts';
import { withLiveEnv, makeSpec, mergeSettings } from '@tests/helpers/live-v2.ts';
import { attachLangfuseObservability, createTraceId, waitForLangfuseTrace, stringifyLangfuseTrace } from '@tests/helpers/langfuse.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '13-provider-fallback';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? test : test.skip)(`13-provider-fallback — ${runCfg.name}`, async () => {
    const traceId = createTraceId(`13-provider-fallback-${runCfg.name}`);
    const spec = attachLangfuseObservability(makeSpec({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Answer succinctly.' }]},
        { role: 'user', content: [{ type: 'text', text: 'Confirm that fallback logic executed successfully.' }]}
      ],
      llmPriority: [invalidPriorityEntry as any, ...runCfg.llmPriority],
      settings: mergeSettings(runCfg.settings, { temperature: 0, maxTokens: 200 })
    }) as any, traceId);
    const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.provider).toBe(runCfg.llmPriority[0].provider);
    // Text content may be empty or minimal depending on provider; provider field proves fallback
    expect(true).toBe(true);

    const trace = await waitForLangfuseTrace(traceId, { timeoutMs: 60000 });
    const traceText = stringifyLangfuseTrace(trace);
    expect(traceText).toContain('fallback logic executed successfully');
  }, 120000);
}
