// 01 — Tool and Context: echo tool usage and context in args
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns, liveTestTimeout } from '../config.ts';
import { withLiveEnv, makeSpec, mergeSettings } from '@tests/helpers/live-v2.ts';
import { attachLangfuseObservability, createTraceId, toolNameVariants, waitForLangfuseTrace, stringifyLangfuseTrace } from '@tests/helpers/langfuse.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '01-tool-and-context';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? describe : describe.skip)(`01-tool-and-context — ${runCfg.name}`, () => {
    test('Call 1 — remember + echo via function', async () => {
      const timestamp = Date.now();
      const secret = `SECRET_${timestamp}`;
      const message = `context_message_${timestamp}`;

      const traceId = createTraceId(`01-tool-and-context-${runCfg.name}-call-1`);
      const spec = attachLangfuseObservability(makeSpec({
        messages: [
          {
            role: 'system',
            content: [{
              type: 'text',
              text: `You must use a function when it can perform the requested action.\nFor any request to reflect a phrase, use the available function.\n\nWhen calling the function, pass the exact phrase you are asked to reflect as the function argument.\nAfter the function completes, respond with a brief confirmation.`
            }]
          },
          {
            role: 'user',
            content: [{
              type: 'text',
              text: `Remember this code: ${secret}.\n\nThen call the reflection function with argument message exactly equal to: ${message}\n\nDo not add quotes or extra characters.`
            }]
          }
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        toolChoice: { type: 'required', allowed: ['test.echo'] },
        settings: mergeSettings(runCfg.settings, {
          temperature: 0.1,
          maxTokens: 60000,
          provider: { require_parameters: true }
        })
      }) as any, traceId);

      const result = await runCoordinator({
        args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env: withLiveEnv({ TEST_FILE })
      });
      if (result.code !== 0 && /No endpoints found that can handle the requested parameters/i.test(result.stderr)) {
        expect(true).toBe(true);
        return;
      }
      expect(result.code).toBe(0);

      const payload = JSON.parse(result.stdout.trim());
      const toolCalls = payload.toolCalls || [];
      expect(Array.isArray(toolCalls) && toolCalls.length >= 1).toBe(true);

      const echoCall = toolCalls.find((c: any) => String(c?.name ?? '').includes('echo'));
      expect(echoCall).toBeTruthy();

      const echoArgsRaw = echoCall?.arguments ?? echoCall?.args ?? {};
      const echoArgs = typeof echoArgsRaw === 'string' ? JSON.parse(echoArgsRaw) : echoArgsRaw;
      const echoedMessage = String(echoArgs?.message ?? '');
      expect(echoedMessage.includes(message)).toBe(true);

      const expectedToolResult = `[R:${echoedMessage.length}]${echoedMessage.split('').reverse().join('')}`;
      const toolResults = payload?.raw?.toolResults;
      const foundToolResult = Array.isArray(toolResults) && toolResults.some((r: any) => {
        if (!r || typeof r !== 'object') return false;
        const tool = String(r.tool ?? '');
        const result = r.result;
        const value =
          typeof result === 'string'
            ? result
            : typeof result?.result === 'string'
              ? result.result
              : '';
        return tool.includes('echo') && value === expectedToolResult;
      });
      expect(foundToolResult).toBe(true);

      const trace = await waitForLangfuseTrace(traceId, { timeoutMs: 90000, testFileBase: TEST_FILE });
      const traceText = stringifyLangfuseTrace(trace);
      expect(toolNameVariants('test.echo').some(v => traceText.includes(v))).toBe(true);
      expect(traceText).toContain(message);
    }, liveTestTimeout(120000));

    test('Call 2 — use context value as parameter to function', async () => {
      const N = 42;
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: `You must use a function when it can perform the requested action.\nIf the user provides a value and asks you to reflect it, call the reflection function with exactly that value.` }]},
          { role: 'user', content: [{ type: 'text', text: `My favorite number is ${N}. Now reflect my favorite number back to me using the function.` }]}
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        toolChoice: { type: 'required', allowed: ['test.echo'] },
        settings: mergeSettings(runCfg.settings, { temperature: 0.1, maxTokens: 60000, provider: { require_parameters: true } })
      });
      const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
      if (result.code !== 0 && /No endpoints found that can handle the requested parameters/i.test(result.stderr)) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const toolCalls = payload.toolCalls || [];
      expect(Array.isArray(toolCalls) && toolCalls.length >= 1).toBe(true);
      const containsN = toolCalls.some((c: any) => {
        const args = c.arguments || c.args || {};
        return JSON.stringify(args).includes(String(N));
      });
      expect(containsN).toBe(true);
      const finalText = String(payload.content?.[0]?.text ?? '');
      expect(finalText.trim().length > 0).toBe(true);
    }, liveTestTimeout(120000));
  });
}
