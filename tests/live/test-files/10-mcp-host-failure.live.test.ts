import { mergeSettings, runLlmOnce } from '@tests/helpers/live-v3.ts';
import type { LLMResponse, Message } from '@/kernel/index.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '10-mcp-host-failure';

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text } as any] };
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('MCP host/process failures surface as structured tool_execution_failed', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const systemPrompt = [
      'You are a conformance test agent.',
      'Follow the user instruction exactly.'
    ].join('\n');

    const prompt = [
      'Call MCP tool crashmcp.crash (no args).',
      'Do not call any other tools.'
    ].join('\n');

    const spec = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
        userMessage(prompt)
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, {
        maxTokens: 256,
        maxToolIterations: 1,
        toolFinalPromptEnabled: true
      }),
      mcpServers: ['crashmcp'],
      toolChoice: { type: 'single', name: 'crashmcp.crash' }
    };

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'host-failure' });
    expect(call.result.code).toBe(0);
    expect(call.response).toBeTruthy();

    const response = call.response as LLMResponse;
    const toolResults = Array.isArray((response as any)?.raw?.toolResults)
      ? (response as any).raw.toolResults
      : [];
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(String(toolResults[0]?.tool || '')).toContain('crashmcp');
    expect(toolResults[0]?.result?.error).toBe('tool_execution_failed');
    expect(typeof toolResults[0]?.result?.message).toBe('string');
  }, 180_000);
});
