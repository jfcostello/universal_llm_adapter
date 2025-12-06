// 04 — Parallel Execution
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, mergeSettings } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '04-parallel-execution';

function providerNotSupportingTools(stderr: string): boolean {
  return /No endpoints found that can handle the requested parameters/i.test(stderr);
}

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? test : test.skip)(`04-parallel-execution — ${runCfg.name}`, async () => {
    const spec = makeSpec({
      messages: [
        { role: 'system', content: [{ type: 'text', text: [
          'You are a strict tool-using assistant. When asked to reflect items, you MUST call the reflection function for each item and must not simulate results.',
          '',
          'Goal',
          '- Reflect every listed item using the reflection tool; do not skip any item.',
          '- After tools complete, produce ONE final assistant message that explicitly mentions the TOOL RESULT for each item exactly once.',
          '',
          'Items to reflect',
          '"elephant", "fox", "butterfly"',
          '',
          'Output Contract (do not include code fences):',
          '- A short sentence that explicitly mentions the ACTUAL TOOL RESULT for each reflected item exactly once.',
          '- Use the exact values returned by the tool - do not make up results.',
          '- No lists or bullet points; a single concise sentence is preferred.',
          '',
          'Format Example (structure only; placeholders, not the real items):',
          '"Reflected: <toolResultA>, <toolResultB>, <toolResultC>."',
          '',
          'Hard Rules',
          '- Never invent tool results.',
          '- Mention each actual tool result exactly once in the final message.',
        ].join('\n') }]},
        { role: 'user', content: [{ type: 'text', text: 'Process all items and mention the actual tool results, remember, you MUST mention each TOOL RESULT explicitly once or the task will fail.' }]}
      ],
      llmPriority: runCfg.llmPriority,
      functionToolNames: ['test.echo'],
      settings: mergeSettings(runCfg.settings, { temperature: 0.1, maxTokens: 60000, parallelToolExecution: true, maxToolIterations: 5, provider: { require_parameters: true } })
    });
    const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
    if (result.code !== 0 && providerNotSupportingTools(result.stderr)) { expect(true).toBe(true); return; }
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    const toolCalls = payload.toolCalls || [];
    expect(toolCalls.length).toBeGreaterThanOrEqual(3);
    const text = String(payload.content?.[0]?.text ?? '');
    // Tool transforms: "elephant" -> "[R:8]tnahpele", "fox" -> "[R:3]xof", "butterfly" -> "[R:9]ylfrettub"
    // Some models include the full tool result, others just the reversed text
    expect(text.includes('tnahpele')).toBe(true);
    expect(text.includes('xof')).toBe(true);
    expect(text.includes('ylfrettub')).toBe(true);
  }, 120000);
}
