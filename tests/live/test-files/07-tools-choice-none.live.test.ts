import { mergeSettings, runLlmOnce } from '@tests/helpers/live.ts';
import type { LLMResponse, Message } from '@tests/helpers/live-types.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '07-tools-choice-none';

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text } as any] };
}

function extractAssistantText(response: LLMResponse): string {
  const content = Array.isArray(response?.content) ? response.content : [];
  return content
    .filter(p => p && typeof p === 'object' && (p as any).type === 'text')
    .map(p => String((p as any).text ?? ''))
    .join('');
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('toolChoice=none disables tool execution even when tools are available', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const sentinel = `NO_TOOLS_OK_${Date.now()}`;
    const systemPrompt = [
      'You are a conformance test agent.',
      'Follow the user instruction exactly.'
    ].join('\n');

    const prompt = [
      'You are given access to tools, but tool execution has been disabled.',
      'If you cannot call tools, do not attempt tool calls.',
      `Reply with exactly ${sentinel}.`
    ].join('\n');

    const spec = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
        userMessage(prompt)
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { maxTokens: 128 }),
      functionToolNames: ['test.random', 'test.echo'],
      toolChoice: 'none'
    };

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'none' });
    expect(call.result.code).toBe(0);
    expect(call.response).toBeTruthy();

    const response = call.response as LLMResponse;
    expect(Array.isArray(response.toolCalls) ? response.toolCalls.length : 0).toBe(0);
    expect((response as any)?.raw?.toolResults).toBeUndefined();
    expect(extractAssistantText(response).trim()).toBe(sentinel);
  }, 180_000);
});
