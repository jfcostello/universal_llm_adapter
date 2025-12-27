import { collectDeltaText, mergeSettings, runLlmStreamOnce } from '@tests/helpers/live-v3.ts';
import type { LLMResponse, Message } from '@/kernel/index.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '04-tools-auto-preserveN-mcpON';

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
  const runCfg = filteredTestRuns[0];

  test('Tool choice auto accepts tools+MCP without forcing tool calls', async () => {
    expect(runCfg).toBeTruthy();

    const sentinel = `AUTO_TOOLCHOICE_OK_${Date.now()}`;
    const systemPrompt = [
      'You are a conformance test agent.',
      'Do not call any tools unless explicitly instructed by the user.',
      'Reply with the exact sentinel string the user provides, and nothing else.'
    ].join('\n');

    const prompt = `Reply with exactly: ${sentinel}`;

    const spec = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
        userMessage(prompt)
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, {
        maxTokens: 128,
        maxToolIterations: 1,
        preserveToolResults: 1,
        toolCountdownEnabled: true,
        parallelToolExecution: true,
        toolResultMaxChars: 40
      }),
      functionToolNames: ['test.random', 'test.echo'],
      mcpServers: ['testmcp'],
      toolChoice: 'auto'
    };

    const call = await runLlmStreamOnce({ spec, testFileBase: TEST_FILE, testName: 'turn1' });
    expect(call.result.code).toBe(0);
    expect(call.done).toBeTruthy();

    const doneResponse = (call.done as any).response as LLMResponse;
    const out = extractAssistantText(doneResponse).trim();
    expect(out).toBe(sentinel);

    const deltas = collectDeltaText(call.events).trim();
    expect(deltas).toContain(sentinel);
  }, 180_000);
});
