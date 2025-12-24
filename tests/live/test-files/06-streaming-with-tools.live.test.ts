// 06 — Streaming with Tools
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, parseStream, findDone, mergeSettings } from '@tests/helpers/live-v2.ts';
import { attachLangfuseObservability, createTraceId, toolNameVariants, waitForLangfuseTrace, stringifyLangfuseTrace } from '@tests/helpers/langfuse.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '06-streaming-with-tools';

function providerNotSupportingTools(stderr: string): boolean {
  return /No endpoints found that can handle the requested parameters/i.test(stderr);
}

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? describe : describe.skip)(`06-streaming-with-tools — ${runCfg.name}`, () => {
    test('Call 1 (stream) — detect + execute + follow‑up', async () => {
      const traceId = createTraceId(`06-streaming-with-tools-${runCfg.name}-call-1`);
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'When the user asks to perform an action and then report the result, call the appropriate function FIRST, wait for the actual result, then provide your text response using the ACTUAL TOOL RESULT. Do not simulate or make up results.' }]},
          { role: 'user', content: [{ type: 'text', text: 'Call the function that reflects "magnificent", then tell me what it actually returned.' }]}
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        toolChoice: { type: 'required', allowed: ['test.echo'] },
        settings: mergeSettings(runCfg.settings, { temperature: 0.1, maxTokens: 60000, provider: { require_parameters: true } })
      });
      const result = await runCoordinator({
        args: ['stream', '--spec', JSON.stringify(attachLangfuseObservability(spec as any, traceId)), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env: withLiveEnv({ TEST_FILE })
      });
      if (result.code !== 0 && providerNotSupportingTools(result.stderr)) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const events = parseStream(result.stdout);
      const toolCallEvents = events.filter(e => e.type === 'tool_call');
      const toolEvents = events.filter(e => e.type === 'TOOL' || e.type === 'tool');
      const hasToolResultMidstream = toolEvents.some(e => (e.toolEvent?.type || '').toLowerCase() === 'tool_result');
      expect(toolCallEvents.length).toBeGreaterThan(0);
      expect(hasToolResultMidstream).toBe(true);
      const done = findDone(events);
      expect(done?.response?.toolCalls?.length).toBeGreaterThan(0);

      const trace = await waitForLangfuseTrace(traceId, { timeoutMs: 60000 });
      const traceText = stringifyLangfuseTrace(trace);
      expect(toolNameVariants('test.echo').some(v => traceText.includes(v))).toBe(true);
      expect(traceText).toContain('toolCalls');
    }, 180000);

    test('Call 2 (stream) — multiple in streaming', async () => {
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Make exactly two separate tool calls when instructed. Do not combine inputs into a single tool call.' }]},
          { role: 'user', content: [{ type: 'text', text: 'Call test.echo twice: (1) message="quantum" then (2) message="paradigm".' }]}
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        toolChoice: { type: 'required', allowed: ['test.echo'] },
        settings: mergeSettings(runCfg.settings, { temperature: 0.1, maxTokens: 60000, provider: { require_parameters: true } })
      });
      const result = await runCoordinator({ args: ['stream', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
      if (result.code !== 0 && providerNotSupportingTools(result.stderr)) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const events = parseStream(result.stdout);
      const toolCallEvents = events.filter(e => e.type === 'tool_call');
      const done = findDone(events);
      expect(toolCallEvents.length).toBeGreaterThanOrEqual(2);
      expect((done?.response?.toolCalls || []).length).toBeGreaterThanOrEqual(2);
    }, 180000);
  });
}
