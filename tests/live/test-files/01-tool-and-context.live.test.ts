// 01 — Tool and Context: echo tool usage and context in args
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, mergeSettings } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? describe : describe.skip)(`01-tool-and-context — ${runCfg.name}`, () => {
    test('Call 1 — remember + echo via function', async () => {
      const timestamp = Date.now();
      const secret = `SECRET_${timestamp}`;
      const message = `context_message_${timestamp}`;
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: `You must use a function when it can perform the requested action.\nFor any request to repeat or reflect a phrase, use the available function that reflects input text verbatim.\n\nREQUIRED PROTOCOL:\n- Read the user's message carefully.\n- If the user asks you to remember a code and also to reflect a message, perform both tasks.\n- Use the function for reflecting the message; do not simulate results.\n- After the function completes, provide a brief confirmation that includes the exact code you were asked to remember.` }]},
          { role: 'user', content: [{ type: 'text', text: `Remember this code: ${secret}. Then, using the available function that reflects text verbatim, reflect this message: "${message}".` }]}
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        toolChoice: { type: 'required', allowed: ['test.echo'] },
        settings: mergeSettings(runCfg.settings, { temperature: 0.1, maxTokens: 60000, provider: { require_parameters: true } })
      });
      const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE: '01-tool-and-context' }) });
      if (result.code !== 0 && /No endpoints found that can handle the requested parameters/i.test(result.stderr)) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const toolCalls = payload.toolCalls || [];
      expect(Array.isArray(toolCalls) && toolCalls.length >= 1).toBe(true);
      const foundEcho = toolCalls.some((c: any) => {
        const args = c.arguments || c.args || {};
        const argStr = JSON.stringify(args);
        return (c.name || '').includes('echo') && argStr.includes(message);
      });
      expect(foundEcho).toBe(true);
      const text = String(payload.content?.[0]?.text ?? '');
      expect(text.includes(secret)).toBe(true);
    }, 120000);

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
      const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE: '01-tool-and-context' }) });
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
    }, 120000);
  });
}

