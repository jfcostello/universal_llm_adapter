import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live.ts';
import { filteredRealtimeTestRuns } from '../config.ts';
import { getRealtimeProviderSelectionErrorMessage } from '../realtime-provider-selection.ts';

const runLive = process.env.LLM_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;
const pluginsPath = './plugins';
const TEST_FILE = '36-realtime-concurrency-isolation';

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
      test('concurrent sessions are isolated (no cross-talk)', async () => {
        // Prefer simple, speech-friendly tokens to avoid STT altering random strings.
        const pick = () => WORD_TOKENS[Math.floor(Math.random() * WORD_TOKENS.length)]!;
        const tokenA = pick();
        let tokenB = pick();
        while (tokenB === tokenA) tokenB = pick();

        const baseSpec = {
          provider: runCfg.provider,
          model: runCfg.model,
          systemPrompt: 'When asked for the token, reply with the exact token and nothing else.',
          transcription: { enabled: true },
          turnDetection: { mode: 'manual_commit' },
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          },
          timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
        };

        const envA = withLiveEnv({ TEST_FILE: `${TEST_FILE}-A` });
        const envB = withLiveEnv({ TEST_FILE: `${TEST_FILE}-B` });

        const scenarioA = runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env: envA,
          spec: {
            ...baseSpec,
            history: [{ role: 'user', text: `My token is ${tokenA}.` }]
          },
          steps: [
            { type: 'send_text', text: 'What token did I mention? Reply with the token only.', role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
            { type: 'close' }
          ],
          timeoutMs: 30000
        });

        const scenarioB = runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env: envB,
          spec: {
            ...baseSpec,
            history: [{ role: 'user', text: `My token is ${tokenB}.` }]
          },
          steps: [
            { type: 'send_text', text: 'What token did I mention? Reply with the token only.', role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
            { type: 'close' }
          ],
          timeoutMs: 30000
        });

        const [resA, resB] = await Promise.all([scenarioA, scenarioB]);
        expect(resA.code).toBe(0);
        expect(resB.code).toBe(0);

        const eventsA = resA.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
        const eventsB = resB.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);

        const textA = getFinalAssistantText(eventsA).toLowerCase();
        const textB = getFinalAssistantText(eventsB).toLowerCase();

        expect(textA.includes(tokenA.toLowerCase())).toBe(true);
        expect(textA.includes(tokenB.toLowerCase())).toBe(false);
        expect(textB.includes(tokenB.toLowerCase())).toBe(true);
        expect(textB.includes(tokenA.toLowerCase())).toBe(false);
      }, 240_000);
    });
  }
}
