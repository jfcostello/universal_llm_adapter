import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live.ts';
import { filteredRealtimeTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;
const pluginsPath = './plugins';
const TEST_FILE = '30-realtime-manual-core';

function getAssistantFinals(events: any[]): string[] {
  const finals = events
    .filter(e => e?.type === 'assistant_text.final' || e?.type === 'assistant_transcript.final')
    .map(e => String(e?.text ?? '').trim())
    .filter(Boolean);
  return finals;
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
        throw new Error(
          'No realtime live test runs are selected. ' +
          'Set LLM_TEST_PROVIDERS=openai|google|grok|vapi (or unset it to run all realtime providers).'
        );
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
              'You MUST follow the rules exactly.',
              'Rules:',
              '1) Do not greet.',
              '2) When asked for a token, reply with the token only.',
              '3) Do not add extra words.'
            ].join('\n'),
            history: [{ role: 'user', text: `My history token is ${tokenHistory}. Remember it.` }],
            transcription: { enabled: true },
            turnDetection: { mode: 'manual_commit' },
            audio: {
              input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
              output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
            },
            timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
          },
          steps: [
            { type: 'send_text', text: 'What token did I mention in the history? Reply with the token only.', role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
            { type: 'send_text', text: `My second token is ${tokenTurn}. Reply with the token only.`, role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
            { type: 'send_text', text: 'What is my second token? Reply with the token only.', role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
            { type: 'close' }
          ],
          timeoutMs: 30000
        });

        expect(result.code).toBe(0);
        const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
        const finals = getAssistantFinals(events).map(t => t.toLowerCase());
        expect(finals.some(t => t.includes(tokenHistory.toLowerCase()))).toBe(true);
        expect(finals.some(t => t.includes(tokenTurn.toLowerCase()))).toBe(true);
      }, 180_000);
    });
  }
}
