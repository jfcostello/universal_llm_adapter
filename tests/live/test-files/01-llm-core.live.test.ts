import { attachLangfuseObservability, createTraceId } from '@tests/helpers/langfuse.ts';
import { createLiveTurnRunner, mergeSettings } from '@tests/helpers/live.ts';
import type { ContentPart, LLMResponse } from '@tests/helpers/live-types.ts';
import { filteredTestRuns, invalidPriorityEntry } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '01-llm-core';

function lastNonEmptyLine(text: string): string {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function parseJsonLine(text: string): any {
  const line = lastNonEmptyLine(text);
  return JSON.parse(line);
}

function extractText(parts: ContentPart[] | undefined): string {
  const content = Array.isArray(parts) ? parts : [];
  return content
    .filter(p => p && typeof p === 'object' && (p as any).type === 'text')
    .map(p => String((p as any).text ?? ''))
    .join('');
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('Single conversation turn plan (success → big input → validation error → recovery)', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const secret = `SECRET_${Date.now()}_SHOULD_NOT_LEAK`;
    const systemPrompt = [
      'You are a conformance test agent.',
      'You MUST follow the user instruction exactly.',
      'When the user says "Reply with exactly X", you MUST output exactly X and nothing else.',
      'No punctuation. No extra whitespace. No code blocks. No quotes.'
    ].join('\n');

    const traceId = createTraceId(`${TEST_FILE}-${Date.now()}`);

    const baseSpec = attachLangfuseObservability(
      {
        messages: [{ role: 'system', content: [{ type: 'text', text: systemPrompt } as any] }],
        llmPriority: [invalidPriorityEntry, ...runCfg.llmPriority],
        settings: mergeSettings(runCfg.settings, {
          maxTokens: 256,
          // Secret-like key name should be redacted if it ever surfaces.
          extra: { apiKey: secret }
        }),
        // Ensure the core suite doesn't enable tools/MCP/vector implicitly.
        tools: [],
        mcpServers: [],
        vectorContexts: undefined
      },
      traceId
    );

    const runner = createLiveTurnRunner({ baseSpec, testFileBase: TEST_FILE });

    // Turn 1 (baseline success)
    const t1 = await runner.runTurn('Reply with exactly CORE_OK', 'turn1');
    expect(t1.result.code).toBe(0);
    expect(t1.response).toBeTruthy();
    const r1 = t1.response as LLMResponse;
    expect(typeof r1.provider).toBe('string');
    expect(typeof r1.model).toBe('string');
    expect(r1.role).toBe('assistant');
    expect(Array.isArray(r1.content)).toBe(true);
    expect(extractText(r1.content).trim()).toBe('CORE_OK');
    expect(t1.result.stderr).not.toContain(secret);
    expect(t1.result.logs.join('\n')).not.toContain(secret);

    // Turn 2 (large input resilience)
    const bigBlob = 'A'.repeat(20_000);
    const t2 = await runner.runTurn(`${bigBlob}\nReply with exactly CORE_BIG_OK`, 'turn2');
    if (t2.result.code === 0) {
      expect(t2.response).toBeTruthy();
      expect(extractText((t2.response as any).content).trim()).toBe('CORE_BIG_OK');
    } else {
      const body = parseJsonLine(t2.result.stderr);
      expect(body?.type).toBe('error');
      expect(typeof body?.error?.code).toBe('string');
    }
    expect(t2.result.stderr).not.toContain(secret);
    expect(t2.result.logs.join('\n')).not.toContain(secret);

    // Turn 3 (structured validation error)
    const t3 = await runner.runTurn([{ type: 'text', text: 123 } as any], 'turn3');
    expect(t3.result.code).not.toBe(0);
    const body3 = parseJsonLine(t3.result.stderr);
    expect(body3?.type).toBe('error');
    expect(body3?.error?.code).toBe('validation_error');
    expect(t3.result.stderr).not.toContain(secret);
    expect(t3.result.logs.join('\n')).not.toContain(secret);

    // Turn 4 (recovery)
    const t4 = await runner.runTurn('Reply with exactly CORE_OK_2', 'turn4');
    expect(t4.result.code).toBe(0);
    expect(t4.response).toBeTruthy();
    expect(extractText((t4.response as any).content).trim()).toBe('CORE_OK_2');
    expect(t4.result.stderr).not.toContain(secret);
    expect(t4.result.logs.join('\n')).not.toContain(secret);
  }, 180_000);
});
