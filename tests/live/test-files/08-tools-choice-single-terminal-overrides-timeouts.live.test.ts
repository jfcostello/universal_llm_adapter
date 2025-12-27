import { mergeSettings, runLlmOnce } from '@tests/helpers/live.ts';
import type { LLMResponse, Message } from '@tests/helpers/live-types.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '08-tools-choice-single-terminal-overrides-timeouts';

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

  const systemPrompt = [
    'You are a conformance test agent.',
    'Follow the user instructions exactly.',
    'When instructed to call a tool, call it with the exact JSON arguments.',
    'If you receive a user message that begins with "All tool calls have been consumed", reply with the FINAL_OK token provided by the user, and nothing else.'
  ].join('\n');

  const baseSpec = {
    llmPriority: runCfg?.llmPriority,
    settings: runCfg
      ? mergeSettings(runCfg.settings, {
          maxTokens: 256,
          maxToolIterations: 1,
          toolFinalPromptEnabled: true,
          parallelToolExecution: false
        })
      : {},
    functionToolNames: ['test.control'],
    toolChoice: { type: 'single', name: 'test.control' }
  };

  test('Terminal tool stops the loop immediately (finishReason=tool_stop)', async () => {
    expect(runCfg).toBeTruthy();

    const prompt = [
      'Call tool test.control with override=null and sleepMs=0.',
      'Do not call any other tools.'
    ].join('\n');

    const spec = {
      ...baseSpec,
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
        userMessage(prompt)
      ]
    };

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'terminal-stops' });
    expect(call.result.code).toBe(0);
    expect(call.response).toBeTruthy();

    const response = call.response as LLMResponse;
    expect(response.finishReason).toBe('tool_stop');
    const toolResults = Array.isArray((response as any)?.raw?.toolResults) ? (response as any).raw.toolResults : [];
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolResults[0]?.tool).toBe('test.control');
  }, 180_000);

  test('terminal=false override forces follow-up + final prompt (tool is terminal by definition)', async () => {
    expect(runCfg).toBeTruthy();

    const finalOk = `FINAL_OK_${Date.now()}`;
    const prompt = [
      `FINAL_OK=${finalOk}`,
      'Call tool test.control with override=false and sleepMs=0.',
      'Do not call any other tools.'
    ].join('\n');

    const spec = {
      ...baseSpec,
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
        userMessage(prompt)
      ]
    };

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'override-false' });
    expect(call.result.code).toBe(0);
    expect(call.response).toBeTruthy();

    const response = call.response as LLMResponse;
    expect(extractAssistantText(response).trim()).toBe(finalOk);
    const toolResults = Array.isArray((response as any)?.raw?.toolResults) ? (response as any).raw.toolResults : [];
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolResults[0]?.tool).toBe('test.control');
    expect(toolResults[0]?.result?.tool_type_response_override_terminal).toBe(false);
  }, 180_000);

  test('Non-boolean terminal override values are ignored', async () => {
    expect(runCfg).toBeTruthy();

    const prompt = [
      'Call tool test.control with override="not-a-boolean" and sleepMs=0.',
      'Do not call any other tools.'
    ].join('\n');

    const spec = {
      ...baseSpec,
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
        userMessage(prompt)
      ]
    };

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'override-nonboolean' });
    expect(call.result.code).toBe(0);
    expect(call.response).toBeTruthy();

    const response = call.response as LLMResponse;
    expect(response.finishReason).toBe('tool_stop');
    const toolResults = Array.isArray((response as any)?.raw?.toolResults) ? (response as any).raw.toolResults : [];
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolResults[0]?.tool).toBe('test.control');
    expect(toolResults[0]?.result?.tool_type_response_override_terminal).toBe('not-a-boolean');
  }, 180_000);

  test('Tool routing respects configured timeouts (timeout yields tool_execution_failed)', async () => {
    expect(runCfg).toBeTruthy();

    const prompt = [
      'Call tool test.control with override=null and sleepMs=2000.',
      'Do not call any other tools.'
    ].join('\n');

    const spec = {
      ...baseSpec,
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
        userMessage(prompt)
      ]
    };

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'timeout' });
    expect(call.result.code).toBe(0);
    expect(call.response).toBeTruthy();

    const response = call.response as LLMResponse;
    expect(response.finishReason).toBe('tool_stop');
    const toolResults = Array.isArray((response as any)?.raw?.toolResults) ? (response as any).raw.toolResults : [];
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolResults[0]?.tool).toBe('test.control');
    expect(toolResults[0]?.result?.error).toBe('tool_execution_failed');
    expect(String(toolResults[0]?.result?.message || '')).toMatch(/timeout/i);
  }, 180_000);
});
