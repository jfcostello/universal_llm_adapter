import type { RealtimeAudioFrame } from '@/modules/kernel/index.ts';
import { mapGeminiLiveServerMessage, type GeminiRealtimeMapperState } from '@/plugins/realtime-compat/gemini/internal/event-mapper.ts';

function makeState(): GeminiRealtimeMapperState {
  const base: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'> = { format: 'pcm16', sampleRateHz: 24000, channels: 1 };
  return {
    audio: { input: base, output: base },
    unifiedToolNameByProviderName: new Map<string, string>(),
    toolNameByCallId: new Map<string, string>(),
    toolCallSeq: 0,
    sawUsageThisTurn: false,
    userTranscriptRaw: '',
    userTranscript: '',
    pendingUserTranscriptFinal: false,
    assistantTranscriptRaw: '',
    assistantTranscript: ''
  };
}

describe('realtime-compat/gemini — event mapper', () => {
  test('ignores setupComplete acks', () => {
    expect(mapGeminiLiveServerMessage({ setupComplete: {} }, makeState())).toEqual([]);
  });

  test('ignores non-object messages', () => {
    expect(mapGeminiLiveServerMessage(null as any, makeState())).toEqual([]);
  });

  test('maps usageMetadata', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage(
      { usageMetadata: { promptTokenCount: 1, responseTokenCount: 2, totalTokenCount: 3 } },
      state
    );
    expect(events).toEqual([]);
    expect(state.pendingUsage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      metadata: { totalTokenCount: 3 }
    });

    const done = mapGeminiLiveServerMessage({ serverContent: { turnComplete: true } }, state);
    expect(done[done.length - 1]).toEqual({
      type: 'usage',
      inputTokens: 1,
      outputTokens: 2,
      metadata: { totalTokenCount: 3 }
    });
  });

  test('ignores usageMetadata when payload is not an object', () => {
    const state = makeState();
    expect(mapGeminiLiveServerMessage({ usageMetadata: [] }, state)).toEqual([]);
    expect(state.pendingUsage).toBeUndefined();
  });

  test('usageMetadata handles missing/non-numeric fields', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage(
      { usageMetadata: { promptTokenCount: 'x', responseTokenCount: 'y', totalTokenCount: 'z', cachedContentTokenCount: 9 } },
      state
    );
    expect(events).toEqual([]);
    expect(state.pendingUsage).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      metadata: { cachedContentTokenCount: 9 }
    });

    const done = mapGeminiLiveServerMessage({ serverContent: { turnComplete: true } }, state);
    expect(done[done.length - 1]).toEqual({
      type: 'usage',
      inputTokens: undefined,
      outputTokens: undefined,
      metadata: { cachedContentTokenCount: 9 }
    });
  });

  test('maps goAway to error', () => {
    const events = mapGeminiLiveServerMessage({ goAway: { timeLeft: '1s' } }, makeState());
    expect(events[0]).toEqual({ type: 'error', message: 'Server requested disconnect', code: 'go_away:1s' });

    const errEvents = mapGeminiLiveServerMessage({ goAway: {}, usageMetadata: { promptTokenCount: 1 } }, makeState());
    expect(errEvents.some(e => e.type === 'usage')).toBe(true);
    expect(errEvents.some(e => e.type === 'error')).toBe(true);
  });

  test('maps toolCall to tool_call.start/end', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage(
      { toolCall: { functionCalls: [{ id: 'c1', name: 'test_echo', args: { message: 'Tokyo' } }] } },
      state
    );
    expect(events[0]).toEqual({ type: 'tool_call.start', toolCallId: 'c1', name: 'test_echo' });
    expect(events[1]).toEqual({ type: 'tool_call.end', toolCallId: 'c1', name: 'test_echo', arguments: { message: 'Tokyo' } });
    expect(state.toolNameByCallId.get('c1')).toBe('test_echo');
  });

  test('maps provider tool names back to unified tool names when configured', () => {
    const state = makeState();
    state.unifiedToolNameByProviderName.set('test_echo', 'test.echo');

    const events = mapGeminiLiveServerMessage(
      { toolCall: { functionCalls: [{ id: 'c1', name: 'test_echo', args: { message: 'Tokyo' } }] } },
      state
    );
    expect(events[0]).toEqual({ type: 'tool_call.start', toolCallId: 'c1', name: 'test.echo' });
    expect(events[1]).toEqual({ type: 'tool_call.end', toolCallId: 'c1', name: 'test.echo', arguments: { message: 'Tokyo' } });
    // Preserve provider name for subsequent tool responses.
    expect(state.toolNameByCallId.get('c1')).toBe('test_echo');
  });

  test('maps toolCall from serverContent and supports args as JSON string', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage(
      { serverContent: { toolCall: { functionCalls: [{ id: 'c1', name: 'test_echo', args: '{\"message\":\"Tokyo\"}' }] } } },
      state
    );
    expect(events[0]).toEqual({ type: 'tool_call.start', toolCallId: 'c1', name: 'test_echo' });
    expect(events[1]).toEqual({ type: 'tool_call.end', toolCallId: 'c1', name: 'test_echo', arguments: { message: 'Tokyo' } });
  });

  test('generates a toolCall id when missing', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage(
      { toolCall: { functionCalls: [{ name: 'test_echo', args: { message: 'Tokyo' } }] } },
      state
    );
    expect(events[0]).toEqual({ type: 'tool_call.start', toolCallId: 'call_1', name: 'test_echo' });
    expect(events[1]).toEqual({ type: 'tool_call.end', toolCallId: 'call_1', name: 'test_echo', arguments: { message: 'Tokyo' } });
    expect(state.toolNameByCallId.get('call_1')).toBe('test_echo');
  });

  test('maps functionCall parts inside modelTurn.parts', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage(
      { serverContent: { modelTurn: { parts: [{ functionCall: { name: 'test_echo', args: { message: 'Tokyo' } } }] } } },
      state
    );
    expect(events[0]).toEqual({ type: 'tool_call.start', toolCallId: 'call_1', name: 'test_echo' });
    expect(events[1]).toEqual({ type: 'tool_call.end', toolCallId: 'call_1', name: 'test_echo', arguments: { message: 'Tokyo' } });
  });

  test('ignores toolCall when args is neither object nor string', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage(
      { toolCall: { functionCalls: [{ id: 'c1', name: 'test_echo', args: 1 }] } },
      state
    );
    expect(events).toEqual([]);
  });

  test('ignores toolCall when args is not a JSON object', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage(
      { toolCall: { functionCalls: [{ id: 'c1', name: 'test_echo', args: '[]' }] } },
      state
    );
    expect(events).toEqual([]);
  });

  test('ignores toolCall when args JSON is invalid', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage(
      { toolCall: { functionCalls: [{ id: 'c1', name: 'test_echo', args: '{' }] } },
      state
    );
    expect(events).toEqual([]);
  });

  test('ignores toolCall when functionCalls is not an array', () => {
    expect(mapGeminiLiveServerMessage({ toolCall: { functionCalls: {} } }, makeState())).toEqual([]);
  });

  test('maps transcripts, audio chunks, text, and turn completion', () => {
    const state = makeState();

    const first = mapGeminiLiveServerMessage(
      {
        serverContent: {
          inputTranscription: { text: 'hello' },
          outputTranscription: { text: 'hi' },
          modelTurn: { parts: [{ text: 'x' }, { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] }
        }
      },
      state
    );
    expect(first.some(e => e.type === 'user_transcript.delta')).toBe(true);
    expect(first.some(e => e.type === 'assistant_transcript.delta')).toBe(true);
    const audio = first.find(e => e.type === 'assistant_audio.chunk') as any;
    expect(audio.frame.format).toBe('pcm16');
    expect(audio.frame.sampleRateHz).toBe(24000);
    expect(audio.frame.dataBase64).toBe('AAA=');

    const complete = mapGeminiLiveServerMessage(
      { serverContent: { turnComplete: true } },
      state
    );
    expect(complete.some(e => e.type === 'assistant_audio.end')).toBe(true);
    expect(complete.some(e => e.type === 'assistant_transcript.final')).toBe(true);
  });

  test('emits user_transcript.final at turn completion when pending', () => {
    const state = makeState();
    state.pendingUserTranscriptFinal = true;
    state.userTranscript = 'hello';

    const events = mapGeminiLiveServerMessage({ serverContent: { generationComplete: true } }, state);
    expect(events.some(e => e.type === 'usage')).toBe(true);
    expect(events.some(e => e.type === 'user_transcript.final' && (e as any).text === 'hello')).toBe(true);
    expect(state.userTranscript).toBe('');
    expect(state.pendingUserTranscriptFinal).toBe(false);
  });

  test('maps nested usageMetadata under serverContent', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage({ serverContent: { usageMetadata: { promptTokenCount: 2 } } }, state);
    expect(events).toEqual([]);

    const done = mapGeminiLiveServerMessage({ serverContent: { turnComplete: true } }, state);
    expect(done[done.length - 1]).toEqual({ type: 'usage', inputTokens: 2, outputTokens: undefined });
  });

  test('emits real usage at turnComplete when usageMetadata was captured earlier', () => {
    const state = makeState();
    const usage = mapGeminiLiveServerMessage({ usageMetadata: { promptTokenCount: 2 } }, state);
    expect(usage).toEqual([]);
    expect(state.sawUsageThisTurn).toBe(true);
    expect(state.pendingUsage).toEqual({ inputTokens: 2, outputTokens: undefined });

    const turnComplete = mapGeminiLiveServerMessage({ serverContent: { turnComplete: true } }, state);
    expect(turnComplete[turnComplete.length - 1]).toEqual({ type: 'usage', inputTokens: 2, outputTokens: undefined });
    expect(state.sawUsageThisTurn).toBe(false);
    expect(state.pendingUsage).toBeUndefined();
  });

  test('diffAsDelta returns empty delta when next is empty', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage({ serverContent: { inputTranscription: { text: '' } } }, state);
    expect(events).toEqual([]);
    expect(state.userTranscript).toBe('');
  });

  test('diffAsDelta returns full replacement when next is not a prefix of prev', () => {
    const state = makeState();
    const first = mapGeminiLiveServerMessage({ serverContent: { inputTranscription: { text: 'hello' } } }, state);
    expect(first.find(e => e.type === 'user_transcript.delta')).toEqual({ type: 'user_transcript.delta', textDelta: 'hello' });

    const second = mapGeminiLiveServerMessage({ serverContent: { inputTranscription: { text: 'bye' } } }, state);
    expect(second.find(e => e.type === 'user_transcript.delta')).toEqual({ type: 'user_transcript.delta', textDelta: 'bye' });
  });

  test('diffAsDelta returns only the suffix when next extends prev', () => {
    const state = makeState();
    mapGeminiLiveServerMessage({ serverContent: { inputTranscription: { text: 'hello' } } }, state);

    const events = mapGeminiLiveServerMessage({ serverContent: { inputTranscription: { text: 'hello world' } } }, state);
    expect(events.find(e => e.type === 'user_transcript.delta')).toEqual({ type: 'user_transcript.delta', textDelta: ' world' });
  });

  test('supports alternative inputTranscription field names', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage({ serverContent: { inputTranscription: { transcript: 'hello' } } }, state);
    expect(events.find(e => e.type === 'user_transcript.delta')).toEqual({ type: 'user_transcript.delta', textDelta: 'hello' });
  });

  test('supports inputTranscription.value', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage({ serverContent: { inputTranscription: { value: 'hello' } } }, state);
    expect(events.find(e => e.type === 'user_transcript.delta')).toEqual({ type: 'user_transcript.delta', textDelta: 'hello' });
  });

  test('maps interrupted to playback.clear_requested and resets output buffers', () => {
    const state = makeState();
    state.assistantTranscript = 'x';

    const events = mapGeminiLiveServerMessage({ serverContent: { interrupted: true } }, state);
    expect(events[0].type).toBe('playback.clear_requested');
    expect(state.assistantTranscript).toBe('');
  });

  test('ignores unknown payloads', () => {
    expect(mapGeminiLiveServerMessage({}, makeState())).toEqual([]);
    expect(mapGeminiLiveServerMessage({ serverContent: { modelTurn: { parts: [null, 1, {}] } } }, makeState())).toEqual([]);
  });

  test('ignores invalid functionCall id types but still processes other part fields', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage(
      {
        serverContent: {
          modelTurn: {
            parts: [
              { functionCall: { id: 1, name: 'test_echo', args: { ok: true } }, text: 'hi' },
              { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }
            ]
          }
        }
      },
      state
    );
    expect(events.some(e => e.type === 'tool_call.start')).toBe(false);
    expect(events.find(e => e.type === 'assistant_audio.chunk')).toBeTruthy();
  });

  test('ignores non-audio inlineData and missing inlineData fields', () => {
    const state = makeState();

    const nonAudio = mapGeminiLiveServerMessage(
      { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'text/plain', data: 'AAA=' } }] } } },
      state
    );
    expect(nonAudio).toEqual([]);

    const missingField = mapGeminiLiveServerMessage(
      { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: '' } }] } } },
      state
    );
    expect(missingField).toEqual([]);
  });

  test('ignores malformed tool calls', () => {
    const state = makeState();
    const events = mapGeminiLiveServerMessage({ toolCall: { functionCalls: [{ id: 1, name: 'test_echo', args: { ok: true } }] } }, state);
    expect(events).toEqual([]);
    expect(state.toolNameByCallId.size).toBe(0);
  });
});
