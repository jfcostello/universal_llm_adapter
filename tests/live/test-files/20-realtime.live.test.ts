// 20 — Realtime: audio in/out, transcripts, tools, barge-in primitive, telephony mode
import path from 'path';
import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live-v2.ts';
import { filteredRealtimeTestRuns as testRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';

function fixturePath(name: string): string {
  return path.resolve(process.cwd(), 'tests', 'live', 'fixtures', 'realtime', name);
}

function getFinalTranscript(events: any[], type: 'user' | 'assistant'): string {
  if (type === 'assistant') {
    const textFinals = events.filter(e => e?.type === 'assistant_text.final');
    const lastText = textFinals[textFinals.length - 1];
    if (lastText?.text) return String(lastText.text).trim();

    const transcriptFinals = events.filter(e => e?.type === 'assistant_transcript.final');
    const lastTranscript = transcriptFinals[transcriptFinals.length - 1];
    return String(lastTranscript?.text ?? '').trim();
  }

  const transcriptFinals = events.filter(e => e?.type === 'user_transcript.final');
  const last = transcriptFinals[transcriptFinals.length - 1];
  return String(last?.text ?? '').trim();
}

function findToolCallEnd(events: any[], toolName: string): any | undefined {
  return events.find(e => e?.type === 'tool_call.end' && e?.name === toolName);
}

function parseRememberedNumberFromTranscript(text: string): string | null {
  const raw = String(text ?? '').toLowerCase();
  const digits = raw.match(/\d+/)?.[0];
  if (digits) return digits;

  const normalized = raw.replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Common ASR variants for "42".
  if ((normalized.includes('forty') || normalized.includes('fourty')) && normalized.includes('two')) return '42';
  if (normalized.includes('four') && normalized.includes('two')) return '42';

  // Fallback: single-digit cases.
  if (normalized.includes('four')) return '4';
  if (normalized.includes('two')) return '2';
  return null;
}

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];

  (runLive ? describe : describe.skip)(`20-realtime — ${runCfg.name}`, () => {
    const provider = runCfg.provider;
    const model = runCfg.model;

    test('Audio → user transcript final', async () => {
      const env = withLiveEnv({ TEST_FILE: '20-realtime-audio-in' });

      const result = await runRealtimeScenario({
        pluginsPath,
        cwd: process.cwd(),
        env,
        spec: {
          provider,
          model,
          systemPrompt: 'Transcribe user speech accurately. Respond briefly.',
          transcription: { enabled: true },
          turnDetection: { mode: 'manual_commit' },
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          },
          timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
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
          { type: 'commit' },
          { type: 'wait_for_event', eventType: 'user_transcript.final', timeoutMs: 30000 },
          { type: 'close' }
        ],
        timeoutMs: 30000
      });

      expect(result.code).toBe(0);
      const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
      const text = getFinalTranscript(events, 'user').toLowerCase();
      // Provider ASR can vary on proper nouns; assert the stable portion of the utterance.
      expect(text.includes('capital of france')).toBe(true);
    }, 120000);

    test('Text → assistant transcript final', async () => {
      const env = withLiveEnv({ TEST_FILE: '20-realtime-text-in' });

      const result = await runRealtimeScenario({
        pluginsPath,
        cwd: process.cwd(),
        env,
        spec: {
          provider,
          model,
          systemPrompt: 'Answer with exactly one word: Paris.',
          transcription: { enabled: true },
          turnDetection: { mode: 'manual_commit' },
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          },
          timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
        },
        steps: [
          { type: 'send_text', text: 'What is the capital of France?', role: 'user' },
          { type: 'commit' },
          { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
          { type: 'close' }
        ],
        timeoutMs: 30000
      });

      expect(result.code).toBe(0);
      const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
      const text = getFinalTranscript(events, 'assistant').toLowerCase();
      expect(text.includes('paris')).toBe(true);
    }, 120000);

    test('History injection (spec.history) influences first response', async () => {
      const env = withLiveEnv({ TEST_FILE: '20-realtime-history-injection' });
      const token = 'HISTORY_TOKEN_291_X9Y8Z7';

      const result = await runRealtimeScenario({
        pluginsPath,
        cwd: process.cwd(),
        env,
        spec: {
          provider,
          model,
          systemPrompt:
            'You will be given prior conversation history. When asked what token was mentioned earlier, reply with that exact token.',
          history: [{ role: 'user', text: `My unique token is ${token}. Please remember it.` }],
          transcription: { enabled: true },
          turnDetection: { mode: 'manual_commit' },
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          },
          timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
        },
        steps: [
          { type: 'send_text', text: 'What token did I mention earlier? Reply with the token only.', role: 'user' },
          { type: 'commit' },
          { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
          { type: 'close' }
        ],
        timeoutMs: 30000
      });

      expect(result.code).toBe(0);
      const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
      const text = getFinalTranscript(events, 'assistant').toLowerCase();
      expect(text.includes(token.toLowerCase())).toBe(true);
    }, 120000);

    test('Tool calling via adapter tool system', async () => {
      const env = withLiveEnv({ TEST_FILE: '20-realtime-tools' });

      const result = await runRealtimeScenario({
        pluginsPath,
        cwd: process.cwd(),
        env,
        spec: {
          provider,
          model,
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
          timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
        },
        steps: [
          { type: 'send_text', text: 'ECHO:level', role: 'user' },
          { type: 'commit' },
          { type: 'wait_for_event', eventType: 'tool_call.end', timeoutMs: 30000 },
          { type: 'wait_for_event', eventType: 'tool_result.sent', timeoutMs: 30000 },
          { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
          { type: 'close' }
        ],
        timeoutMs: 30000
      });

      expect(result.code).toBe(0);
      const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
      const toolCall = findToolCallEnd(events, 'test.echo');
      expect(Boolean(toolCall)).toBe(true);
      expect(String(toolCall?.arguments?.message ?? '').toLowerCase()).toBe('level');

      expect(events.some(e => e?.type === 'tool_result.sent')).toBe(true);

      // `test.echo` returns `[R:<len>]<reversed>`. Using a palindrome token keeps the output stable to assert on via transcripts.
      const text = getFinalTranscript(events, 'assistant').toLowerCase();
      expect(text.includes('level')).toBe(true);
    }, 120000);

    test('In-session memory (audio then text)', async () => {
      const env = withLiveEnv({ TEST_FILE: '20-realtime-memory' });

      const result = await runRealtimeScenario({
        pluginsPath,
        cwd: process.cwd(),
        env,
        spec: {
          provider,
          model,
          systemPrompt: 'Follow user instructions exactly.',
          transcription: { enabled: true },
          turnDetection: { mode: 'manual_commit' },
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          },
          timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
        },
        steps: [
          {
            type: 'send_audio_file',
            filePath: fixturePath('remember-number-42.pcm16_24k.raw'),
            frameFormat: 'pcm16',
            sampleRateHz: 24000,
            channels: 1,
            chunkMs: 20
          },
          { type: 'commit' },
          { type: 'wait_for_event', eventType: 'user_transcript.final', timeoutMs: 30000 },
          // Some providers emit an assistant confirmation for the audio turn; drain turn completion
          // markers so the follow-up assertion targets the *second* (text) turn deterministically.
          { type: 'wait_for_event', eventType: 'usage', timeoutMs: 30000 },
          { type: 'send_text', text: 'What number did I ask you to remember? Answer digits only.', role: 'user' },
          { type: 'commit' },
          { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
          { type: 'close' }
        ],
        timeoutMs: 30000
      });

      expect(result.code).toBe(0);
      const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
      const userTranscript = getFinalTranscript(events, 'user');
      const expectedDigits = parseRememberedNumberFromTranscript(userTranscript);
      if (!expectedDigits) {
        throw new Error(`Could not parse remembered number from user transcript: ${JSON.stringify(userTranscript)}`);
      }

      const assistantText = getFinalTranscript(events, 'assistant');
      const assistantDigits = parseRememberedNumberFromTranscript(assistantText) ?? '';

      // The audio fixture intends to convey "42", but provider ASR may mis-hear.
      // If the model returns the intended value, accept it. Otherwise require it to
      // match what the provider transcribed from the audio.
      if (assistantDigits !== '42') {
        expect(assistantDigits).toBe(expectedDigits);
      }
    }, 120000);

    test('Interrupt primitive keeps session usable', async () => {
      const env = withLiveEnv({ TEST_FILE: '20-realtime-interrupt' });

      const result = await runRealtimeScenario({
        pluginsPath,
        cwd: process.cwd(),
        env,
        spec: {
          provider,
          model,
          systemPrompt:
            'When asked to talk, speak continuously and slowly. If interrupted, stop immediately and answer the next user question normally.',
          transcription: { enabled: true },
          turnDetection: { mode: 'manual_commit' },
          bargeIn: { enabled: true },
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          },
          timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
        },
        steps: [
          { type: 'send_text', text: 'Talk for a long time about the alphabet.', role: 'user' },
          { type: 'commit' },
          { type: 'wait_for_event', eventType: 'assistant_audio.chunk', timeoutMs: 30000 },
          { type: 'interrupt', reason: 'interrupt' },
          { type: 'wait_for_event', eventType: 'playback.clear_requested', timeoutMs: 30000 },
          // Ensure the interrupted response has fully completed so we don't accidentally
          // match its transcript final when verifying the follow-up question.
          { type: 'wait_for_event', eventType: 'usage', timeoutMs: 30000 },
          { type: 'send_text', text: 'What is 2 + 2? Reply digits only.', role: 'user' },
          { type: 'commit' },
          { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
          { type: 'close' }
        ],
        timeoutMs: 30000
      });

      expect(result.code).toBe(0);
      const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
      const assistantFinals = events
        .filter(e => e?.type === 'assistant_text.final' || e?.type === 'assistant_transcript.final')
        .map(e => String(e?.text ?? '').trim())
        .filter(Boolean)
        .join('\n');
      expect(assistantFinals.includes('4')).toBe(true);
    }, 120000);

    test('Telephony mode (g711_ulaw @ 8k)', async () => {
      const env = withLiveEnv({ TEST_FILE: '20-realtime-telephony' });

      const result = await runRealtimeScenario({
        pluginsPath,
        cwd: process.cwd(),
        env,
        spec: {
          provider,
          model,
          systemPrompt: 'Transcribe user speech and respond briefly.',
          transcription: { enabled: true },
          turnDetection: { mode: 'manual_commit' },
          audio: {
            input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
            output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
          },
          timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
        },
        steps: [
          {
            type: 'send_audio_file',
            filePath: fixturePath('echo-token.ulaw_8k.raw'),
            frameFormat: 'g711_ulaw',
            sampleRateHz: 8000,
            channels: 1,
            chunkMs: 20
          },
          { type: 'commit' },
          { type: 'wait_for_event', eventType: 'user_transcript.final', timeoutMs: 30000 },
          { type: 'close' }
        ],
        timeoutMs: 30000
      });

      expect(result.code).toBe(0);
      const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
      const text = getFinalTranscript(events, 'user').toLowerCase();
      // Telephony codecs + provider ASR can be lossy; assert we received a coherent transcript.
      expect(text.includes('echo token')).toBe(true);
    }, 120000);

    test('Concurrent sessions (no cross-talk)', async () => {
      const baseEnv = withLiveEnv({ TEST_FILE: '20-realtime-concurrent' });

      const runOne = async (token: string, label: string) => {
        const env = { ...baseEnv, LLM_TEST_NAME: label };
        const result = await runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env,
          spec: {
            provider,
            model,
            systemPrompt: `Session token: ${token}. When the user says \"GO\", reply with exactly: ${token}. No other words or punctuation.`,
            transcription: { enabled: true },
            turnDetection: { mode: 'manual_commit' },
            audio: {
              input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
              output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
            },
            timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
          },
          steps: [
            { type: 'send_text', text: 'GO', role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
            { type: 'close' }
          ],
          timeoutMs: 30000
        });

        expect(result.code).toBe(0);
        const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
        const text = events
          .filter(
            e =>
              e?.type === 'assistant_transcript.delta' ||
              e?.type === 'assistant_transcript.final' ||
              e?.type === 'assistant_text.delta' ||
              e?.type === 'assistant_text.final'
          )
          .map(e => String(e?.textDelta ?? e?.text ?? ''))
          .join('')
          .toLowerCase();
        expect(text.includes(token.toLowerCase())).toBe(true);
      };

      await Promise.all([
        runOne('kiwi', 'session-1'),
        runOne('mango', 'session-2'),
        runOne('papaya', 'session-3')
      ]);
    }, 180000);
  });
}
