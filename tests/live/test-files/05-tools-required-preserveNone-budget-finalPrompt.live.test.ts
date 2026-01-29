import { buildLogPathFor, mergeSettings, parseLogBodies, runLlmOnce } from '@tests/helpers/live.ts';
import type { LLMResponse, Message } from '@tests/helpers/live-types.ts';
import { getToolRoutingRouteIds } from '@tests/helpers/adapter-logs.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '05-tools-required-preserveNone-budget-finalPrompt';

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

type NormalizedLiveRequestBody = {
  __liveType?: string;
  messages?: any[];
  tools?: any[];
  toolChoice?: any;
};

function findNormalizedRequestBodies(bodies: any[]): NormalizedLiveRequestBody[] {
  return bodies
    .filter(b => b && typeof b === 'object' && b.__liveType === 'normalized_llm_request')
    .map(b => b as NormalizedLiveRequestBody);
}

function hasToolRedactionPlaceholder(messages: any[]): boolean {
  const placeholder = 'This is a placeholder, not the original tool response; the tool output has been redacted to save context.';
  return messages.some(msg =>
    Array.isArray(msg?.content) &&
    msg.content.some((part: any) => part?.type === 'text' && String(part?.text || '').includes(placeholder))
  );
}

function hasRedactedToolResultPart(messages: any[]): boolean {
  return messages.some(msg =>
    Array.isArray(msg?.content) &&
    msg.content.some((part: any) =>
      part?.type === 'tool_result' &&
      part?.result &&
      typeof part.result === 'object' &&
      part.result.redacted === true &&
      part.result.reason === 'context_pruning'
    )
  );
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('Required tool choice + tool budget final prompt; preserveToolResults=none prunes tool outputs', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const marker = `BUDGET_PAYLOAD_${Date.now()}`;
    const finalOk = `FINAL_PROMPT_OK_${Date.now()}`;
    const expectedFinalPrompt = 'All tool calls have been consumed (1 of 1). Provide your final response using the information gathered so far.';

    const systemPrompt = [
      'You are a conformance test agent.',
      'You MUST follow the user instructions exactly.',
      'Tool call rules:',
      '- Your first response MUST be a tool call to test_echo.',
      '- Do NOT describe the tool call.',
      '- Do NOT output JSON.',
      'You MUST emit tool calls exactly as instructed and never guess tool outputs.',
      `When you receive a user message that begins with "All tool calls have been consumed", reply with exactly ${finalOk} and nothing else.`
    ].join('\n');

    const prompt = [
      `Call tool test_echo with message="${marker}".`,
      'After the tool executes, you will receive an injected final prompt about tool budget exhaustion.',
      `When you see that injected final prompt, reply with exactly ${finalOk}.`,
      'Do not call any other tools.'
    ].join('\n');

    const spec = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
        userMessage(prompt)
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, {
        maxTokens: 512,
        maxToolIterations: 1,
        preserveToolResults: 'none',
        toolFinalPromptEnabled: true,
        toolCountdownEnabled: false,
        parallelToolExecution: false,
        toolResultMaxChars: 80
      }),
      functionToolNames: ['test.echo'],
      toolChoice: { type: 'required', allowed: ['test.echo'] }
    };

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'budget-finalPrompt' });
    expect(call.result.code).toBe(0);
    expect(call.response).toBeTruthy();

    const response = call.response as LLMResponse;
    expect(Array.isArray(response.toolCalls)).toBe(true);
    expect(response.toolCalls?.length).toBeGreaterThanOrEqual(1);
    for (const toolCall of response.toolCalls || []) {
      expect(typeof toolCall?.name).toBe('string');
      expect(typeof toolCall?.id).toBe('string');
      expect(toolCall?.args).toEqual(toolCall?.arguments);
    }

    const toolResults = Array.isArray((response as any)?.raw?.toolResults)
      ? (response as any).raw.toolResults
      : [];
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolResults[0]?.tool).toBe('test.echo');
    expect(toolResults[0]?.result).toBe(`[R:${marker.length}]${marker.split('').reverse().join('')}`);

    const routeIds = getToolRoutingRouteIds(call.result.logs, 'test.echo');
    expect(routeIds).toContain('test-echo');

    const out = extractAssistantText(response).trim();
    expect(out).toContain(finalOk);

    const logPath = buildLogPathFor(TEST_FILE);
    const bodies = parseLogBodies(logPath);
    const normalized = findNormalizedRequestBodies(bodies);
    expect(normalized.length).toBeGreaterThan(0);

    const finalPromptBody = normalized.find(b =>
      Array.isArray(b?.messages) &&
      b.messages.some(m =>
        Array.isArray(m?.content) &&
        m.content.some((p: any) => p?.type === 'text' && String(p?.text || '').includes(expectedFinalPrompt))
      )
    );
    expect(finalPromptBody).toBeTruthy();

    const finalMessages = (finalPromptBody as any).messages as any[];
    expect(Array.isArray(finalPromptBody?.tools)).toBe(true);
    expect((finalPromptBody?.tools || []).length).toBe(0);
    expect(finalPromptBody?.toolChoice).toBe('none');
    expect(hasToolRedactionPlaceholder(finalMessages)).toBe(true);
    expect(hasRedactedToolResultPart(finalMessages)).toBe(true);
  }, 180_000);
});
