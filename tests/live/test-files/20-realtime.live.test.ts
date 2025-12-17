// 20 — Realtime: audio in/out, transcripts, tools, barge-in primitive, telephony mode
import path from 'path';
import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const provider = process.env.LLM_REALTIME_PROVIDER;
const pluginsPath = './plugins';

const describeMaybe = runLive && provider ? describe : describe.skip;

function fixturePath(name: string): string {
  return path.resolve(process.cwd(), 'tests', 'live', 'fixtures', 'realtime', name);
}

function getFinalTranscript(events: any[], type: 'user' | 'assistant'): string {
  const want = `${type}_transcript.final`;
  const finals = events.filter(e => e?.type === want);
  const last = finals[finals.length - 1];
  return String(last?.text ?? '').trim();
}

function findToolCallEnd(events: any[], toolName: string): any | undefined {
  return events.find(e => e?.type === 'tool_call.end' && e?.name === toolName);
}

describeMaybe('20-realtime — realtime session contract', () => {
  test('Audio → user transcript final', async () => {
    const env = withLiveEnv({ TEST_FILE: '20-realtime-audio-in' });

    const result = await runRealtimeScenario({
      pluginsPath,
      cwd: process.cwd(),
      env,
      spec: {
        provider,
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
    expect(text.includes('paris')).toBe(true);
  }, 120000);

  test('Text → assistant transcript final', async () => {
    const env = withLiveEnv({ TEST_FILE: '20-realtime-text-in' });

    const result = await runRealtimeScenario({
      pluginsPath,
      cwd: process.cwd(),
      env,
      spec: {
        provider,
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

  test('Tool calling via adapter tool system', async () => {
    const env = withLiveEnv({ TEST_FILE: '20-realtime-tools' });

    const result = await runRealtimeScenario({
      pluginsPath,
      cwd: process.cwd(),
      env,
      spec: {
        provider,
        systemPrompt:
          'When the user says `ECHO:<token>`, you MUST call tool `test.echo` with {message:<token>} and then speak ONLY the tool result.',
        functionToolNames: ['test.echo'],
        transcription: { enabled: true },
        turnDetection: { mode: 'manual_commit' },
        audio: {
          input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
          output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
        },
        timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
      },
      steps: [
        { type: 'send_text', text: 'ECHO:Tokyo', role: 'user' },
        { type: 'commit' },
        { type: 'wait_for_event', eventType: 'tool_call.end', timeoutMs: 30000 },
        { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
        { type: 'close' }
      ],
      timeoutMs: 30000
    });

    expect(result.code).toBe(0);
    const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
    expect(Boolean(findToolCallEnd(events, 'test.echo'))).toBe(true);
    const text = getFinalTranscript(events, 'assistant').toLowerCase();
    expect(text.includes('tokyo')).toBe(true);
  }, 120000);

  test('In-session memory (audio then text)', async () => {
    const env = withLiveEnv({ TEST_FILE: '20-realtime-memory' });

    const result = await runRealtimeScenario({
      pluginsPath,
      cwd: process.cwd(),
      env,
      spec: {
        provider,
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
        { type: 'send_text', text: 'What number did I ask you to remember? Answer digits only.', role: 'user' },
        { type: 'commit' },
        { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
        { type: 'close' }
      ],
      timeoutMs: 30000
    });

    expect(result.code).toBe(0);
    const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
    const text = getFinalTranscript(events, 'assistant');
    expect(text.includes('42')).toBe(true);
  }, 120000);

  test('Interrupt primitive keeps session usable', async () => {
    const env = withLiveEnv({ TEST_FILE: '20-realtime-interrupt' });

    const result = await runRealtimeScenario({
      pluginsPath,
      cwd: process.cwd(),
      env,
      spec: {
        provider,
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
        { type: 'send_text', text: 'What is 2 + 2? Reply digits only.', role: 'user' },
        { type: 'commit' },
        { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
        { type: 'close' }
      ],
      timeoutMs: 30000
    });

    expect(result.code).toBe(0);
    const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
    const text = getFinalTranscript(events, 'assistant').trim();
    expect(text.includes('4')).toBe(true);
  }, 120000);

  test('Telephony mode (g711_ulaw @ 8k)', async () => {
    const env = withLiveEnv({ TEST_FILE: '20-realtime-telephony' });

    const result = await runRealtimeScenario({
      pluginsPath,
      cwd: process.cwd(),
      env,
      spec: {
        provider,
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
    expect(text.includes('tokyo')).toBe(true);
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
          systemPrompt: `Answer with exactly one word: ${token}.`,
          transcription: { enabled: true },
          turnDetection: { mode: 'manual_commit' },
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          },
          timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' }
        },
        steps: [
          { type: 'send_text', text: 'Reply now.', role: 'user' },
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
    };

    await Promise.all([
      runOne('kiwi', 'session-1'),
      runOne('mango', 'session-2'),
      runOne('papaya', 'session-3')
    ]);
  }, 180000);
});
