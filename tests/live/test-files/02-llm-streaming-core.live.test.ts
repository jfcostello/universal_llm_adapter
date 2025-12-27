import { collectDeltaText, mergeSettings, runLlmOnce, runLlmStreamOnce } from '@tests/helpers/live.ts';
import type { ContentPart, LLMResponse, Message } from '@tests/helpers/live-types.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '02-llm-streaming-core';

function extractText(parts: ContentPart[] | undefined): string {
  const content = Array.isArray(parts) ? parts : [];
  return content
    .filter(p => p && typeof p === 'object' && (p as any).type === 'text')
    .map(p => String((p as any).text ?? ''))
    .join('');
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text } as any] };
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('Streaming emits deltas + done and is semantically consistent with non-stream', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const systemPrompt = [
      'You are a conformance test agent.',
      'Follow user instructions.',
      'Respond in plain text.'
    ].join('\n');

    const prompt = 'Return STREAM_PARITY_OK in exactly two short sentences.';

    const baseMessages: Message[] = [{ role: 'system', content: [{ type: 'text', text: systemPrompt } as any] }];
    const baseSpec = {
      messages: baseMessages,
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { maxTokens: 256 }),
      tools: [],
      mcpServers: []
    };

    const spec = { ...baseSpec, messages: [...baseMessages, userMessage(prompt)] };

    const callA = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'nonstream' });
    expect(callA.result.code).toBe(0);
    expect(callA.response).toBeTruthy();
    const responseA = callA.response as LLMResponse;
    const textA = extractText(responseA.content);
    expect(textA).toContain('STREAM_PARITY_OK');
    expect(responseA.toolCalls).toBeUndefined();

    const callB = await runLlmStreamOnce({ spec, testFileBase: TEST_FILE, testName: 'stream' });
    expect(callB.result.code).toBe(0);
    expect(callB.events.length).toBeGreaterThan(0);
    expect(callB.events.some(e => e?.type === 'delta')).toBe(true);
    expect(callB.done).toBeTruthy();

    const doneResponse = (callB.done as any).response as LLMResponse;
    const textB = extractText(doneResponse.content);
    expect(textB).toContain('STREAM_PARITY_OK');
    expect(doneResponse.toolCalls).toBeUndefined();

    const deltasText = collectDeltaText(callB.events);
    expect(deltasText).toBeTruthy();
    expect(textB).toContain(deltasText.trim());

    // Semantic parity (minimal): both results must include the marker and no tool calls.
    expect(textA).toContain('STREAM_PARITY_OK');
    expect(textB).toContain('STREAM_PARITY_OK');
  }, 180_000);
});
