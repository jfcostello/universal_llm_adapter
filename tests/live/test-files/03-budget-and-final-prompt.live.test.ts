// 03 — Budget and Final Prompt
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, buildLogPathFor, parseLogBodies, mergeSettings } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '03-budget-and-final-prompt';

function providerNotSupportingTools(stderr: string): boolean {
  return /No endpoints found that can handle the requested parameters/i.test(stderr);
}

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? describe : describe.skip)(`03-budget-and-final-prompt — ${runCfg.name}`, () => {
    test('Enforce budget and verify final prompt injection', async () => {
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: `You are a function-calling assistant. You must reflect phrases using the function by calling it.

INSTRUCTIONS:
1. Call the function to reflect "initialize"
2. Call the function to reflect "terminate"
3. After both function calls complete, you will receive tool results and system messages
4. Read ALL the tool results and system messages VERY CAREFULLY
5. In your final text response, you MUST:
   - Include the ACTUAL TOOL RESULTS exactly as they were returned (the reversed strings with [R:X] prefix)
   - Pay attention to ANY countdown or limit information provided in the tool result messages
   - Repeat or acknowledge EXACTLY what the tool result messages tell you about remaining calls, limits, or final prompts
   - DO NOT ignore or skip over information provided in the tool result messages

CRITICAL: The tool result messages contain important information about your progress and limits. You MUST read them carefully and acknowledge what they say in your final response.` }]},
          { role: 'user', content: [{ type: 'text', text: 'Do it now, and remember to include the actual tool results in your final response.' }]}
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        settings: mergeSettings(runCfg.settings, { temperature: 0.1, maxTokens: 60000, maxToolIterations: 2, toolCountdownEnabled: true, toolFinalPromptEnabled: true, provider: { require_parameters: true } })
      });
      const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
      if (result.code !== 0 && providerNotSupportingTools(result.stderr)) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const toolCalls = payload.toolCalls || [];
      expect(toolCalls.length).toBeLessThanOrEqual(2);
      const allEcho = toolCalls.every((c: any) => (c.name || '').includes('echo'));
      expect(allEcho).toBe(true);
      const finalText = String(payload.content?.[0]?.text ?? '');
      // Tool transforms: "initialize" -> "[R:10]ezilaitini", "terminate" -> "[R:9]etanimret"
      // Some models include full tool result format, others just the reversed text
      expect(finalText.includes('ezilaitini')).toBe(true);
      expect(finalText.includes('etanimret')).toBe(true);
      // Verify the system injected the final prompt by checking logs
      // (Model may or may not echo back budget info, so we verify system behavior not model behavior)
      const bodies = parseLogBodies(buildLogPathFor(TEST_FILE));
      const lastReq = bodies.reverse().find(b => Array.isArray(b.messages));
      if (lastReq) {
        const serialized = JSON.stringify(lastReq);
        // Verify countdown messages were injected in tool results
        expect(serialized).toMatch(/Tool calls used \d+ of \d+/);
        // Verify final prompt was injected (either "All tool calls have been consumed" or tool budget info)
        const hasFinalPrompt = serialized.includes('All tool calls have been consumed') || serialized.includes('remaining');
        expect(hasFinalPrompt).toBe(true);
      }
    }, 180000);
  });
}

