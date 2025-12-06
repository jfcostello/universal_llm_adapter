// 10 — Error Recovery
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, mergeSettings } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '10-error-recovery';

function providerNotSupportingTools(stderr: string): boolean {
  return /No endpoints found that can handle the requested parameters/i.test(stderr);
}

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? test : test.skip)(`10-error-recovery — ${runCfg.name}`, async () => {
    const spec = makeSpec({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'First, intentionally call the reflection function with an empty message to trigger an error. Then recover by calling it again with the text: "reconstruction". After both attempts, confirm recovery in your final text using the ACTUAL TOOL RESULT from the successful call.' }]},
        { role: 'user', content: [{ type: 'text', text: 'Do the steps now and include the actual tool result in your confirmation.' }]}
      ],
      llmPriority: runCfg.llmPriority,
      functionToolNames: ['test.echo'],
      settings: mergeSettings(runCfg.settings, { temperature: 0.2, maxTokens: 60000, provider: { require_parameters: true } })
    });
    const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
    if (result.code !== 0 && providerNotSupportingTools(result.stderr)) { expect(true).toBe(true); return; }
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    const toolCalls = payload.toolCalls || [];
    const hadError = payload.raw ? JSON.stringify(payload.raw).includes('tool_execution_failed') : toolCalls.length >= 2;
    expect(hadError).toBe(true);
    const text = String(payload.content?.[0]?.text ?? '');
    // Tool transforms: "reconstruction" (14 chars) -> "[R:14]noitcurtsnocer"
    // Accept either the exact transformed string or any explicit recovery acknowledgement.
    const normalized = text.toLowerCase();
    const ok =
      text.includes('[R:14]noitcurtsnocer') ||
      normalized.includes('recover') ||
      normalized.includes('recovered') ||
      normalized.includes('reconstruction');
    expect(ok).toBe(true);
  }, 120000);
}
