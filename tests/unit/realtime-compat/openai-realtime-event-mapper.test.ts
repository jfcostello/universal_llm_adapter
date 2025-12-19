import type { RealtimeAudioFrame } from '@/modules/kernel/index.ts';
import { mapOpenAIRealtimeServerEvent } from '@/plugins/realtime-compat/openai/internal/event-mapper.ts';

function makeState(): any {
  const base: RealtimeAudioFrame = { format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: '' };
  return {
    audio: { input: base, output: base },
    functionNameByCallId: new Map<string, string>(),
    toolNameByProviderName: new Map([['test_echo', 'test.echo']])
  };
}

describe('realtime-compat/openai — event mapper', () => {
  test('maps error event with code and without code', () => {
    const withCode = mapOpenAIRealtimeServerEvent({ type: 'error', error: { message: 'nope', code: 'x' } }, makeState());
    expect(withCode[0]).toEqual({ type: 'error', message: 'nope', code: 'x' });

    const withoutCode = mapOpenAIRealtimeServerEvent({ type: 'error', error: { message: 'nope' } }, makeState());
    expect(withoutCode[0]).toEqual({ type: 'error', message: 'nope' });

    const withoutMessage = mapOpenAIRealtimeServerEvent({ type: 'error', error: {} }, makeState());
    expect(withoutMessage[0]).toEqual({ type: 'error', message: 'Realtime error' });
  });

  test('maps VAD start/stop', () => {
    expect(mapOpenAIRealtimeServerEvent({ type: 'input_audio_buffer.speech_started' }, makeState())[0]).toEqual({
      type: 'user_speech.started'
    });
    expect(mapOpenAIRealtimeServerEvent({ type: 'input_audio_buffer.speech_stopped' }, makeState())[0]).toEqual({
      type: 'user_speech.stopped'
    });
  });

  test('maps user transcript delta/final and handles empty payloads', () => {
    expect(mapOpenAIRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: '' }, makeState())).toEqual(
      []
    );
    expect(mapOpenAIRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.delta' }, makeState())).toEqual([]);
    expect(
      mapOpenAIRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hi' }, makeState())[0]
    ).toEqual({ type: 'user_transcript.delta', textDelta: 'hi' });

    expect(
      mapOpenAIRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' }, makeState())
    ).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.completed' }, makeState())).toEqual([]);
    expect(
      mapOpenAIRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' }, makeState())[0]
    ).toEqual({ type: 'user_transcript.final', text: 'hello' });
  });

  test('maps assistant audio chunk/end and handles empty delta', () => {
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_audio.delta', delta: '' }, makeState())).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_audio.delta' }, makeState())).toEqual([]);

    const state = makeState();
    const chunk = mapOpenAIRealtimeServerEvent({ type: 'response.output_audio.delta', delta: 'AAA=' }, state)[0] as any;
    expect(chunk.type).toBe('assistant_audio.chunk');
    expect(chunk.frame.dataBase64).toBe('AAA=');
    expect(chunk.frame.sampleRateHz).toBe(24000);

    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_audio.done' }, state)[0]).toEqual({ type: 'assistant_audio.end' });
  });

  test('maps assistant transcript delta/final and handles empty payloads', () => {
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_audio_transcript.delta', delta: '' }, makeState())).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_audio_transcript.delta' }, makeState())).toEqual([]);
    expect(
      mapOpenAIRealtimeServerEvent({ type: 'response.output_audio_transcript.delta', delta: 'a' }, makeState())[0]
    ).toEqual({ type: 'assistant_transcript.delta', textDelta: 'a' });

    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_audio_transcript.done', transcript: '' }, makeState())).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_audio_transcript.done' }, makeState())).toEqual([]);
    expect(
      mapOpenAIRealtimeServerEvent({ type: 'response.output_audio_transcript.done', transcript: 'ok' }, makeState())[0]
    ).toEqual({ type: 'assistant_transcript.final', text: 'ok' });
  });

  test('maps assistant text delta/final and handles empty payloads', () => {
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_text.delta', delta: '' }, makeState())).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_text.delta' }, makeState())).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_text.delta', delta: 'x' }, makeState())[0]).toEqual({
      type: 'assistant_text.delta',
      textDelta: 'x'
    });

    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_text.done', text: '' }, makeState())).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_text.done' }, makeState())).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_text.done', text: 'y' }, makeState())[0]).toEqual({
      type: 'assistant_text.final',
      text: 'y'
    });
  });

  test('maps tool call start + args delta/end and covers missing fields', () => {
    const state = makeState();

    // Non-function items ignored
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_item.added', item: { type: 'message' } }, state)).toEqual([]);

    // Missing callId/name ignored
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.output_item.added', item: { type: 'function_call' } }, state)).toEqual([]);
    expect(
      mapOpenAIRealtimeServerEvent({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c0' } }, state)
    ).toEqual([]);
    expect(
      mapOpenAIRealtimeServerEvent({ type: 'response.output_item.added', item: { type: 'function_call', name: 'test.echo' } }, state)
    ).toEqual([]);

    const start = mapOpenAIRealtimeServerEvent(
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1', name: 'test_echo' } },
      state
    )[0];
    expect(start).toEqual({ type: 'tool_call.start', toolCallId: 'c1', name: 'test.echo' });

    const startWithItemId = mapOpenAIRealtimeServerEvent(
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'i1', name: 'test_echo' } },
      state
    )[0];
    expect(startWithItemId).toEqual({ type: 'tool_call.start', toolCallId: 'i1', name: 'test.echo' });

    const unmappedStart = mapOpenAIRealtimeServerEvent(
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c2', name: 'unmapped_tool' } },
      state
    )[0];
    expect(unmappedStart).toEqual({ type: 'tool_call.start', toolCallId: 'c2', name: 'unmapped_tool' });

    expect(mapOpenAIRealtimeServerEvent({ type: 'response.function_call_arguments.delta', call_id: '', delta: '{}' }, state)).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.function_call_arguments.delta', call_id: 'c1', delta: '' }, state)).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.function_call_arguments.delta' }, state)).toEqual([]);

    expect(
      mapOpenAIRealtimeServerEvent({ type: 'response.function_call_arguments.delta', call_id: 'c1', delta: '{' }, state)[0]
    ).toEqual({ type: 'tool_call.arguments_delta', toolCallId: 'c1', jsonDelta: '{' });

    expect(mapOpenAIRealtimeServerEvent({ type: 'response.function_call_arguments.done', call_id: '', arguments: '{}' }, state)).toEqual(
      []
    );
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '' }, state)).toEqual(
      []
    );
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.function_call_arguments.done' }, state)).toEqual([]);

    const end = mapOpenAIRealtimeServerEvent(
      { type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '{"message":"Tokyo"}' },
      state
    )[0] as any;
    expect(end.type).toBe('tool_call.end');
    expect(end.toolCallId).toBe('c1');
    expect(end.name).toBe('test.echo');
    expect(end.arguments).toEqual({ message: 'Tokyo' });
    expect(state.functionNameByCallId.has('c1')).toBe(false);

    const unknownNameEnd = mapOpenAIRealtimeServerEvent(
      { type: 'response.function_call_arguments.done', call_id: 'unknown', arguments: '{"ok":true}' },
      state
    )[0] as any;
    expect(unknownNameEnd.name).toBe('unknown');
  });

  test('tool args must be a JSON object', () => {
    const state = makeState();
    expect(() =>
      mapOpenAIRealtimeServerEvent({ type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '[]' }, state)
    ).toThrow('Tool arguments must be a JSON object');
  });

  test('maps usage on response.done', () => {
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.done', response: {} }, makeState())).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({ type: 'response.done', response: { usage: {} } }, makeState())).toEqual([]);

    const events = mapOpenAIRealtimeServerEvent(
      { type: 'response.done', response: { usage: { input_tokens: 1, output_tokens: 2 } } },
      makeState()
    );
    expect(events[0].type).toBe('usage');
    expect((events[0] as any).inputTokens).toBe(1);
    expect((events[0] as any).outputTokens).toBe(2);

    const nonNumeric = mapOpenAIRealtimeServerEvent(
      { type: 'response.done', response: { usage: { input_tokens: '1', output_tokens: '2' } } },
      makeState()
    )[0] as any;
    expect(nonNumeric.type).toBe('usage');
    expect(nonNumeric.inputTokens).toBeUndefined();
    expect(nonNumeric.outputTokens).toBeUndefined();
  });

  test('ignores unknown events', () => {
    expect(mapOpenAIRealtimeServerEvent({ type: 'something.else' }, makeState())).toEqual([]);
    expect(mapOpenAIRealtimeServerEvent({}, makeState())).toEqual([]);
  });
});
