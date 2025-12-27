import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live-v3.ts';
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
      test('manual commit: history is visible and earlier turns persist', async () => {
        const suffix = `${String(runCfg.name).replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}${Date.now().toString().slice(-4)}`;
        const tokenHistory = `HISTORYTOKEN${suffix}`;
        const tokenTurn = `TURNTOKEN${suffix}`;

        const result = await runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env: withLiveEnv({ TEST_FILE }),
          spec: {
            provider: runCfg.provider,
            model: runCfg.model,
            systemPrompt: [
              'You are a realtime conformance test agent.',
              'When asked to output a token, output the exact token and nothing else.'
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
            { type: 'send_text', text: `My second token is ${tokenTurn}. Reply OK.`, role: 'user' },
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
