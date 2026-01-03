import path from 'path';
import fs from 'fs';
import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live.ts';
import { filteredRealtimeTestRuns } from '../config.ts';
import { getRealtimeProviderSelectionErrorMessage } from '../realtime-provider-selection.ts';

const runLive = process.env.LLM_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;
const pluginsPath = './plugins';
const TEST_FILE = '35-realtime-automatic-turn-detection-audio';

function fixturePath(name: string): string {
  return path.resolve(process.cwd(), 'tests', 'live', 'fixtures', 'realtime', name);
}

function ensureSilenceFixturePcm16_24k_1s(): string {
  const tmpRoot = (globalThis as any).__LLM_ADAPTER_TS_TMP_ROOT__ || process.cwd();
  const filePath = path.join(tmpRoot, 'realtime-silence-1s.pcm16_24k.raw');
  if (fs.existsSync(filePath)) return filePath;
  const bytes = Buffer.alloc(24000 * 2 * 1); // 1s, mono pcm16 @ 24kHz
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

function getFinalTranscript(events: any[], who: 'user' | 'assistant'): string {
  if (who === 'user') {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type === 'user_transcript.final') {
        const text = String(e?.text ?? '').trim();
        if (text) return text;
      }
    }
    return '';
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const isFinal = e?.type === 'assistant_text.final' || e?.type === 'assistant_transcript.final';
    if (!isFinal) continue;
    const text = String(e?.text ?? '').trim();
    if (text) return text;
  }
  return '';
}

if (filteredRealtimeTestRuns.length === 0) {
  describeLive(`${TEST_FILE} — provider selection`, () => {
    test('requires a realtime provider selection', () => {
      throw new Error(getRealtimeProviderSelectionErrorMessage());
    });
  });
} else {
  for (const runCfg of filteredRealtimeTestRuns) {
    describeLive(`${TEST_FILE} — ${runCfg.name}`, () => {
      test('server_vad mode triggers response without explicit commit', async () => {
        const silencePath = ensureSilenceFixturePcm16_24k_1s();
        const result = await runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env: withLiveEnv({ TEST_FILE }),
          spec: {
            provider: runCfg.provider,
            model: runCfg.model,
            systemPrompt: 'Answer with exactly one word: Paris.',
            transcription: { enabled: true },
            turnDetection: { mode: 'server_vad' },
            audio: {
              input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
              output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
            },
            timeout: { maxDurationMs: 120000, idleTimeoutMs: 60000, onTimeout: 'close' }
          },
          steps: [
            {
              type: 'send_audio_file',
              filePath: fixturePath('capital-of-france.pcm16_24k.raw'),
              frameFormat: 'pcm16',
              sampleRateHz: 24000,
              channels: 1,
              chunkMs: 20
            },
            {
              type: 'send_audio_file',
              filePath: silencePath,
              frameFormat: 'pcm16',
              sampleRateHz: 24000,
              channels: 1,
              chunkMs: 20
            },
            { type: 'wait_for_event', eventType: 'user_transcript.final', timeoutMs: 90000 },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 90000 },
            { type: 'close' }
          ],
          timeoutMs: 90000
        });

        expect(result.code).toBe(0);
        const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
        const userText = getFinalTranscript(events, 'user').toLowerCase();
        expect(userText.includes('capital of france')).toBe(true);
        const assistantText = getFinalTranscript(events, 'assistant').toLowerCase();
        expect(assistantText.length > 0).toBe(true);
      }, 240_000);
    });
  }
}
