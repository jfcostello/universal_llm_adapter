import { collectDeltaText, mergeSettings, runLlmStreamOnce } from '@tests/helpers/live.ts';
import type { LLMResponse, Message } from '@tests/helpers/live-types.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '03-llm-streaming-with-tools-mcp';

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text } as any] };
}

function parseMcpTimestampFromToolResult(raw: string): number {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Expected MCP tool result to be an array of content parts');
  }

  const first = parsed[0];
  const text = first?.type === 'text' ? String(first?.text ?? '') : '';
  const payload = JSON.parse(text);
  const timestamp = payload?.timestamp;
  if (typeof timestamp !== 'number') {
    throw new Error('Expected MCP tool result payload to include numeric timestamp');
  }
  return timestamp;
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('Streaming tool + MCP chain is deterministic (anti-guessing)', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const systemPrompt = [
      'You are a conformance test agent.',
      'You MUST call tools exactly as the user instructs.',
      'You MUST do the requested tool calls in the requested order (MCP first, then test.echo).',
      'You MUST NOT output any final answer text until AFTER you have called tool test.echo at least once and received its tool result.',
      'The evaluator will FAIL you if you do not call tool test.echo at least once before answering.',
      'You MUST NOT guess or copy example values; you MUST compute your final answer from the MCP tool result.',
      'After tools run, reply with only what the user asked for, and nothing else.'
    ].join('\n');

    const prompt = [
      'Do these steps in order:',
      '1) Call MCP tool testmcp.test_timestamp (no args).',
      '2) From its JSON text, read the numeric field timestamp and convert it to a string.',
      '3) Call tool test.echo with message equal to that timestamp string.',
      '4) Reply with ONLY the last 4 digits of the timestamp string from step (2) (exactly 4 digits, original order).',
      'IMPORTANT: The tool test.echo returns a transformed string (it reverses the message and prefixes it like [R:13]...).',
      'Do NOT use the test.echo tool output to compute the final 4 digits.',
      'Do not copy any example digits from this prompt; your reply must be computed from the actual timestamp returned by the MCP tool.'
    ].join('\n');

    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
      userMessage(prompt)
    ];

    const spec = {
      messages,
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { maxTokens: 256 }),
      functionToolNames: ['test.random', 'test.echo'],
      mcpServers: ['testmcp'],
      toolChoice: { type: 'required', allowed: ['test.echo', 'testmcp.test_timestamp'] }
    };

    const call = await runLlmStreamOnce({ spec, testFileBase: TEST_FILE, testName: 'streaming-tool-mcp' });
    expect(call.result.code).toBe(0);
    expect(call.events.length).toBeGreaterThan(0);
    expect(call.done).toBeTruthy();

    const toolEvents = call.events
      .filter(e => e?.type === 'tool' && e.toolEvent && typeof e.toolEvent === 'object')
      .map(e => e.toolEvent);
    expect(toolEvents.some(e => typeof e?.type === 'string' && String(e.type).startsWith('tool_call'))).toBe(true);
    expect(toolEvents.some(e => e?.type === 'tool_result')).toBe(true);

    const hasMcpInvocation = toolEvents.some(e => {
      const name = String(e?.name ?? '');
      return name.startsWith('testmcp.') || name.startsWith('testmcp_');
    });
    expect(hasMcpInvocation).toBe(true);

    const mcpResult = toolEvents.find(e => {
      if (e?.type !== 'tool_result') return false;
      const name = String(e?.name ?? '');
      return name.startsWith('testmcp.') || name.startsWith('testmcp_');
    });
    expect(mcpResult).toBeTruthy();

    const mcpTimestamp = parseMcpTimestampFromToolResult(String((mcpResult as any).arguments ?? 'null'));
    const last4 = String(mcpTimestamp).slice(-4);

    const doneResponse = (call.done as any).response as LLMResponse;
    expect(Array.isArray(doneResponse?.toolCalls)).toBe(true);
    expect((doneResponse.toolCalls || []).some(tc => String(tc?.name || '').startsWith('testmcp.'))).toBe(true);
    expect((doneResponse.toolCalls || []).some(tc => String(tc?.name || '') === 'test.echo')).toBe(true);
    const out = Array.isArray(doneResponse?.content)
      ? doneResponse.content
          .filter(p => p && typeof p === 'object' && (p as any).type === 'text')
          .map(p => String((p as any).text ?? ''))
          .join('')
      : '';
    const digitsOnly = out.replace(/\D/g, '');
    expect(digitsOnly.length).toBeGreaterThanOrEqual(4);
    expect(digitsOnly.slice(-4)).toBe(last4);

    const deltasText = collectDeltaText(call.events);
    expect(deltasText).toContain(last4);
  }, 180_000);
});
