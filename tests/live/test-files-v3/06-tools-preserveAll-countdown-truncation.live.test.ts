import { buildLogPathFor, mergeSettings, parseLogBodies, runLlmOnce } from '@tests/helpers/live-v3.ts';
import type { LLMResponse, Message } from '@/kernel/index.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '06-tools-preserveAll-countdown-truncation';

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

function hasPlaceholder(messages: any[]): boolean {
  const placeholder = 'This is a placeholder, not the original tool response; the tool output has been redacted to save context.';
  return messages.some(msg =>
    Array.isArray(msg?.content) &&
    msg.content.some((part: any) => part?.type === 'text' && String(part?.text || '').includes(placeholder))
  );
}

function findToolTextParts(messages: any[]): string[] {
  const toolMessages = messages.filter(m => m?.role === 'tool' && Array.isArray(m?.content));
  const textParts: string[] = [];
  for (const msg of toolMessages) {
    for (const part of msg.content) {
      if (part?.type === 'text') {
        textParts.push(String(part?.text ?? ''));
      }
    }
  }
  return textParts.filter(Boolean);
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('Preserve all: countdown metadata + truncation marker appear in follow-up call context', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const done = `TOOLS_OK_${Date.now()}`;
    const maxChars = 20;

    const systemPrompt = [
      'You are a conformance test agent.',
      'You MUST follow the user instructions exactly.',
      'Call tools only when instructed.',
      'When the user says "Reply with exactly X", you MUST output exactly X and nothing else.'
    ].join('\n');

    const prompt = [
      'Call tool test.random exactly once with min=0 and max=1000000.',
      `Then reply with exactly ${done}.`
    ].join('\n');

    const spec = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
        userMessage(prompt)
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, {
        maxTokens: 256,
        maxToolIterations: 2,
        preserveToolResults: 'all',
        toolCountdownEnabled: true,
        parallelToolExecution: false,
        toolResultMaxChars: maxChars
      }),
      functionToolNames: ['test.random'],
      toolChoice: { type: 'required', allowed: ['test.random'] }
    };

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'countdown-trunc' });
    expect(call.result.code).toBe(0);
    expect(call.response).toBeTruthy();

    const response = call.response as LLMResponse;
    expect(extractAssistantText(response).trim()).toBe(done);

    const toolResults = Array.isArray((response as any)?.raw?.toolResults)
      ? (response as any).raw.toolResults
      : [];
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolResults[0]?.tool).toBe('test.random');
    expect(typeof toolResults[0]?.result?.randomValue).toBe('number');
    expect(typeof toolResults[0]?.result?.timestamp).toBe('number');

    const logPath = buildLogPathFor(TEST_FILE);
    const bodies = parseLogBodies(logPath);
    const normalized = findNormalizedRequestBodies(bodies);
    expect(normalized.length).toBeGreaterThan(0);

    const followUp = normalized.find(b => b?.toolChoice === 'auto' && Array.isArray(b?.messages));
    expect(followUp).toBeTruthy();

    const followUpMessages = (followUp as any).messages as any[];
    expect(hasPlaceholder(followUpMessages)).toBe(false);

    const toolTextParts = findToolTextParts(followUpMessages);
    expect(toolTextParts.some(t => t.includes('Tool calls used 1 of 2 - 1 remaining.'))).toBe(true);
    expect(toolTextParts.some(t => t.includes('Tool result truncated due to size limits.'))).toBe(true);

    const truncatedCandidate = toolTextParts.find(t => t.startsWith('{') && t.endsWith('…'));
    expect(truncatedCandidate).toBeTruthy();
    expect((truncatedCandidate as string).length).toBeGreaterThan(maxChars);
  }, 180_000);
});

