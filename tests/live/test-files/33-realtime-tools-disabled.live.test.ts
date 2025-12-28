import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live.ts';
import { filteredRealtimeTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;
const pluginsPath = './plugins';
const TEST_FILE = '33-realtime-tools-disabled';

function getFinalAssistantText(events: any[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'assistant_text.final' || e?.type === 'assistant_transcript.final') {
      const text = String(e?.text ?? '').trim();
      if (text) return text;
    }
  }
  return '';
}

function findToolCallEnd(events: any[], name: string): any | undefined {
  return events.find(e => e?.type === 'tool_call.end' && e?.name === name);
}

function hasAnyToolEvents(events: any[]): boolean {
  return events.some(e => {
    const t = String(e?.type ?? '');
    return t.startsWith('tool_call.') || t.startsWith('tool_result.');
  });
}

if (filteredRealtimeTestRuns.length === 0) {
  describeLive(`${TEST_FILE} — provider selection`, () => {
    test('requires a realtime provider selection', () => {
      throw new Error(
        'No realtime live test runs are selected. ' +
          'Set LLM_TEST_PROVIDERS=openai|google|grok (or unset it to run all realtime providers).'
      );
    });
  });
} else {
  for (const runCfg of filteredRealtimeTestRuns) {
    describeLive(`${TEST_FILE} — ${runCfg.name}`, () => {
      test('toolChoice=single executes tool and emits tool events', async () => {
        const token = `ECHO_${runCfg.name}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;

        const result = await runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env: withLiveEnv({ TEST_FILE }),
          spec: {
            provider: runCfg.provider,
            model: runCfg.model,
            systemPrompt:
              'When the user says `ECHO:<token>`, you MUST call tool `test.echo` with {message:<token>} and then speak ONLY the tool result.',
            functionToolNames: ['test.echo'],
            toolChoice: { type: 'single', name: 'test.echo' },
            transcription: { enabled: true },
            turnDetection: { mode: 'manual_commit' },
            audio: {
              input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
              output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
            },
            timeout: { maxDurationMs: 90000, idleTimeoutMs: 45000, onTimeout: 'close' }
          },
          steps: [
            { type: 'send_text', text: `ECHO:${token}`, role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'tool_call.end', timeoutMs: 45000 },
            { type: 'wait_for_event', eventType: 'tool_result.sent', timeoutMs: 45000 },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 45000 },
            { type: 'close' }
          ],
          timeoutMs: 45000
        });

        expect(result.code).toBe(0);
        const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
        const toolCall = findToolCallEnd(events, 'test.echo');
        expect(toolCall).toBeTruthy();
        expect(String(toolCall?.arguments?.message ?? '')).toBe(token);
        expect(events.some(e => e?.type === 'tool_result.sent')).toBe(true);
        expect(getFinalAssistantText(events).trim()).toBeTruthy();
      }, 180_000);

      test('toolChoice=none disables tool execution (no tool events)', async () => {
        const token = `NO_TOOL_${runCfg.name}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;

        const result = await runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env: withLiveEnv({ TEST_FILE }),
          spec: {
            provider: runCfg.provider,
            model: runCfg.model,
            systemPrompt: [
              'Tool calls are disabled.',
              'If the user asks you to call a tool, you MUST reply with exactly: TOOL_DISABLED',
              'No punctuation. No quotes. No extra words.',
              `Token: ${token}.`
            ].join('\n'),
            functionToolNames: ['test.random'],
            toolChoice: 'none',
            transcription: { enabled: true },
            turnDetection: { mode: 'manual_commit' },
            audio: {
              input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
              output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
            },
            timeout: { maxDurationMs: 90000, idleTimeoutMs: 45000, onTimeout: 'close' }
          },
          steps: [
            { type: 'send_text', text: `Token=${token}. Please call tool test.random and reply with the randomValue only.`, role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 45000 },
            { type: 'close' }
          ],
          timeoutMs: 45000
        });

        expect(result.code).toBe(0);
        const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
        expect(hasAnyToolEvents(events)).toBe(false);
        const text = getFinalAssistantText(events).trim();
        const normalized = text.replace(/[^A-Za-z]/g, '').toLowerCase();
        expect(normalized.includes('disabled')).toBe(true);
      }, 180_000);
    });
  }
}
