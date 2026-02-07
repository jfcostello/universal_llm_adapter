import { collectDeltaText, mergeSettings, runLlmStreamOnce } from '@tests/helpers/live.ts';
import type { LLMResponse, Message } from '@tests/helpers/live-types.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '03-llm-streaming-with-tools-mcp';

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text } as any] };
}

function isControlNonterminalToolName(raw: string): boolean {
  const name = String(raw || '');
  return name === 'test.control.nonterminal' || name === 'test_control_nonterminal';
}

function isRandomToolName(raw: string): boolean {
  const name = String(raw || '');
  return name === 'test.random' || name === 'test_random';
}

function isParallelTestToolName(raw: string): boolean {
  return isControlNonterminalToolName(raw) || isRandomToolName(raw);
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
  const runCfg = filteredTestRuns[0];

  const systemPrompt = [
    'You are a conformance test agent.',
    'You MUST follow the user instructions exactly.',
    'You MUST call tools exactly as the user instructs (names, args, and ordering).',
    'You MUST NOT guess tool outputs.',
    'You MUST NOT output any final answer text until AFTER you have completed all required tool calls.',
    'After tools run, reply with only what the user asked for, and nothing else.'
  ].join('\n');

  test('Streaming emits parallel tool results as they complete (not tool-call order)', async () => {
    expect(runCfg).toBeTruthy();

    const done = `PARALLEL_TOOL_OK_${Date.now()}`;

    const prompt = [
      'You MUST call these two tools in order: test_control_nonterminal, then test_random.',
      'Do NOT output any text before tool calls are finished.',
      'If you can return BOTH tool calls in your FIRST response (as tool calls), do it (preferred).',
      'If you can only return ONE tool call per assistant message, then call ONLY tool 1 now. Do not call tool 2 until AFTER tool 1 has completed.',
      'Tool 1: call tool test_control_nonterminal with args {"sleepMs": 200}.',
      'Tool 2: call tool test_random with args {}.',
      `After both tool results are available, reply with exactly ${done} and nothing else.`
    ].join('\n');

    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
      userMessage(prompt)
    ];

    const spec = {
      messages,
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, {
        maxTokens: 256,
        maxToolIterations: 2,
        parallelToolExecution: true,
        parallelToolCalls: true
      }),
      functionToolNames: ['test.control.nonterminal', 'test.random'],
      mcpServers: [],
      toolChoice: { type: 'required', allowed: ['test.control.nonterminal', 'test.random'] }
    };

    const call = await runLlmStreamOnce({ spec, testFileBase: TEST_FILE, testName: 'streaming-parallel-tools' });
    expect(call.result.code).toBe(0);
    expect(call.done).toBeTruthy();

    const firstToolResultIdx = call.events.findIndex(e => {
      if (e?.type !== 'tool' || !e.toolEvent || typeof e.toolEvent !== 'object') return false;
      if (e.toolEvent?.type !== 'tool_result') return false;
      return isParallelTestToolName(String(e.toolEvent?.name ?? ''));
    });
    expect(firstToolResultIdx).toBeGreaterThan(-1);

    const toolCallsBeforeFirstResult = call.events
      .slice(0, firstToolResultIdx)
      .filter(e => e?.type === 'tool_call' && e.toolCall && typeof e.toolCall === 'object')
      .map(e => e.toolCall)
      .filter(tc => isParallelTestToolName(String((tc as any)?.name ?? '')));

    const toolResults = call.events
      .filter(e => e?.type === 'tool' && e.toolEvent && typeof e.toolEvent === 'object')
      .map(e => e.toolEvent)
      .filter(e => e?.type === 'tool_result' && isParallelTestToolName(String(e?.name ?? '')))
      .map(e => String(e?.name ?? ''));

    const allToolCalls = call.events
      .filter(e => e?.type === 'tool_call' && e.toolCall && typeof e.toolCall === 'object')
      .map(e => e.toolCall)
      .filter(tc => isParallelTestToolName(String((tc as any)?.name ?? '')));

    expect(allToolCalls.length).toBeGreaterThanOrEqual(2);

    const controlCall = allToolCalls.find(tc => isControlNonterminalToolName(String((tc as any)?.name ?? '')));
    expect(controlCall).toBeTruthy();
    expect((controlCall as any)?.arguments?.sleepMs).toBe(200);

    const randomCall = allToolCalls.find(tc => isRandomToolName(String((tc as any)?.name ?? '')));
    expect(randomCall).toBeTruthy();

    const hasParallelBatch =
      toolCallsBeforeFirstResult.length >= 2 &&
      toolCallsBeforeFirstResult.some(tc => isControlNonterminalToolName(String((tc as any)?.name ?? ''))) &&
      toolCallsBeforeFirstResult.some(tc => isRandomToolName(String((tc as any)?.name ?? '')));

    if (hasParallelBatch) {
      // Both tool calls were emitted before any tool result: prove we streamed tool results
      // as soon as they completed (not in original tool-call order).
      expect(toolResults.length).toBe(2);
      expect(isRandomToolName(toolResults[0])).toBe(true);
      expect(isControlNonterminalToolName(toolResults[1])).toBe(true);
    } else {
      // If the provider emits tool calls one-at-a-time, tool results should be streamed in the
      // same order as tool calls (since each tool completes before the next call can occur).
      expect(toolResults.length).toBe(2);
      expect(toolResults[0]).toBe(String((allToolCalls[0] as any)?.name ?? ''));
      expect(toolResults[1]).toBe(String((allToolCalls[1] as any)?.name ?? ''));
    }

    const doneResponse = (call.done as any).response as LLMResponse;
    const out = Array.isArray(doneResponse?.content)
      ? doneResponse.content
          .filter(p => p && typeof p === 'object' && (p as any).type === 'text')
          .map(p => String((p as any).text ?? ''))
          .join('')
      : '';
    expect(out.trim()).toBe(done);
  }, 180_000);

  test('Streaming tool + MCP chain is deterministic (anti-guessing)', async () => {
    expect(runCfg).toBeTruthy();

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
      settings: mergeSettings(runCfg.settings, {
        maxTokens: 1024,
        maxToolIterations: 6,
        parallelToolExecution: true,
        parallelToolCalls: true
      }),
      functionToolNames: ['test.echo'],
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
