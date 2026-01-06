import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live.ts';
import { filteredRealtimeTestRuns } from '../config.ts';
import { getRealtimeProviderSelectionErrorMessage } from '../realtime-provider-selection.ts';

const runLive = process.env.LLM_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;
const pluginsPath = './plugins';
const TEST_FILE = '30-realtime-manual-core';

function findToolCallEnd(events: any[], name: string): any | undefined {
  return events.find(e => e?.type === 'tool_call.end' && e?.name === name);
}

const WORD_TOKENS = [
  'mango',
  'papaya',
  'kiwi',
  'peach',
  'plum',
  'apricot',
  'banana',
  'orange',
  'grape',
  'melon',
  'guava',
  'lychee',
  'persimmon',
  'kumquat'
];

if (filteredRealtimeTestRuns.length === 0) {
  describeLive(`${TEST_FILE} — provider selection`, () => {
    test('requires a realtime provider selection', () => {
      throw new Error(getRealtimeProviderSelectionErrorMessage());
    });
  });
} else {
  for (const runCfg of filteredRealtimeTestRuns) {
    describeLive(`${TEST_FILE} — ${runCfg.name}`, () => {
      test('manual commit: history is visible and earlier turns persist', async () => {
        const pick = () => WORD_TOKENS[Math.floor(Math.random() * WORD_TOKENS.length)]!;
        const tokenHistory = pick();
        let tokenTurn = pick();
        while (tokenTurn === tokenHistory) tokenTurn = pick();

        const result = await runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env: withLiveEnv({ TEST_FILE }),
          spec: {
            provider: runCfg.provider,
            model: runCfg.model,
            systemPrompt: [
              'You are a realtime conformance test agent.',
              'You MUST follow the rules exactly.',
              '',
              'Rules:',
              '1) Do not greet. Do not explain.',
              '2) You MUST call tool `test.echo` exactly once per user turn.',
              '3) Tool arguments MUST be exactly: {"message":"<payload>"} where <payload> is specified below.',
              '4) Do NOT output any assistant text before the tool call completes.',
              '5) After you receive the tool result, speak ONLY the tool result string.',
              '',
              'Per-turn payload rules:',
              '- When the user says `CALL_HISTORY`, set <payload> to: HISTORY=<history_token>',
              '- When the user says `STORE_SECOND:<token>`, set <payload> to: STORED',
              '- When the user says `CALL_BOTH`, set <payload> to: BOTH=<history_token>|<second_token>',
              '',
              'The <history_token> is provided in the conversation history.',
              'The <second_token> is provided by the user in the STORE_SECOND turn and MUST be remembered for CALL_BOTH.'
            ].join('\n'),
            history: [{ role: 'user', text: `My history token is ${tokenHistory}. Remember it.` }],
            functionToolNames: ['test.echo'],
            toolChoice: { type: 'single', name: 'test.echo' },
            transcription: { enabled: true },
            turnDetection: { mode: 'manual_commit' },
            audio: {
              input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
              output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
            },
            timeout: { maxDurationMs: 180000, idleTimeoutMs: 60000, onTimeout: 'close' }
          },
          steps: [
            { type: 'send_text', text: 'CALL_HISTORY', role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'tool_call.end', timeoutMs: 60000 },
            { type: 'wait_for_event', eventType: 'tool_result.sent', timeoutMs: 60000 },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 60000 },
            { type: 'send_text', text: `STORE_SECOND:${tokenTurn}`, role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'tool_call.end', timeoutMs: 60000 },
            { type: 'wait_for_event', eventType: 'tool_result.sent', timeoutMs: 60000 },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 60000 },
            { type: 'send_text', text: 'CALL_BOTH', role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'tool_call.end', timeoutMs: 60000 },
            { type: 'wait_for_event', eventType: 'tool_result.sent', timeoutMs: 60000 },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 60000 },
            { type: 'close' }
          ],
          timeoutMs: 60000
        });

        expect(result.code).toBe(0);
        const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
        const toolCall = findToolCallEnd(events, 'test.echo');
        expect(toolCall).toBeTruthy();
        expect(
          events.some(e => e?.type === 'tool_call.end' && String(e?.arguments?.message ?? '') === `HISTORY=${tokenHistory}`)
        ).toBe(true);
        expect(
          events.some(e => e?.type === 'tool_call.end' && String(e?.arguments?.message ?? '') === 'STORED')
        ).toBe(true);
        expect(
          events.some(
            e =>
              e?.type === 'tool_call.end' &&
              String(e?.arguments?.message ?? '') === `BOTH=${tokenHistory}|${tokenTurn}`
          )
        ).toBe(true);
      }, 180_000);
    });
  }
}
