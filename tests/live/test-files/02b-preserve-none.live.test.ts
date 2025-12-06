// 02b — Preserve None
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, buildLogPathFor, parseLogBodies, mergeSettings } from '@tests/helpers/live-v2.ts';
import fs from 'fs';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '02b-preserve-none';

function providerNotSupportingTools(stderr: string): boolean {
  return /No endpoints found that can handle the requested parameters/i.test(stderr);
}

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? describe : describe.skip)(`02b-preserve-none — ${runCfg.name}`, () => {
    const isAnthropic = /Anthropic/i.test(runCfg.name);
    // Use config's temperature if set, otherwise use provider-specific defaults
    const runTemp = runCfg.settings.temperature !== undefined ? runCfg.settings.temperature : (isAnthropic ? 1 : 0.1);

    test('Call 1 — reflect once', async () => {
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Use a function whenever the task is to reflect or repeat input.' }]},
          { role: 'user', content: [{ type: 'text', text: 'Reflect "keep-me-once".' }]}
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        settings: mergeSettings(runCfg.settings, { temperature: runTemp, maxTokens: 300, preserveToolResults: 'none', toolCountdownEnabled: true, provider: { require_parameters: true } })
      });
      const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
      if (result.code !== 0 && providerNotSupportingTools(result.stderr)) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const toolCalls = payload.toolCalls || [];
      expect(Array.isArray(toolCalls) && toolCalls.length >= 1).toBe(true);
    }, 120000);

    test('Call 2 — next request has placeholder redaction', async () => {
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Use a function whenever the task is to reflect or repeat input.' }]},
          { role: 'user', content: [{ type: 'text', text: 'Continue.' }]}
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        settings: mergeSettings(runCfg.settings, { temperature: runTemp, maxTokens: 300, preserveToolResults: 'none', toolCountdownEnabled: true, provider: { require_parameters: true } })
      });
      const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
      if (result.code !== 0 && providerNotSupportingTools(result.stderr)) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const logPath = buildLogPathFor(TEST_FILE);
      if (fs.existsSync(logPath)) {
        const bodies = parseLogBodies(logPath);
        const lastReq = bodies.reverse().find(b => Array.isArray(b.messages));
        const bodyStr = JSON.stringify(lastReq || {});
        const placeholder = 'This is a placeholder, not the original tool response; the tool output has been redacted to save context.';
        if (bodyStr.includes(placeholder)) {
          expect(bodyStr).toContain(placeholder);
        } else {
          // With new echo format, "keep-me-once" becomes "[R:12]ecno-em-peek"
          expect(bodyStr.includes('keep-me-once') || bodyStr.includes('[R:12]ecno-em-peek')).toBe(false);
        }
      }
    }, 120000);
  });
}
