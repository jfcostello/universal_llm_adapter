import type { RealtimeAudioFrame } from '@/kernel/index.ts';
import { mapGrokRealtimeServerEvent } from '@/plugins/realtime-compat/grok/internal/event-mapper.ts';

describe('realtime-compat/grok — event mapper', () => {
  const audio: { input: RealtimeAudioFrame; output: RealtimeAudioFrame } = {
    input: { format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: '' },
    output: { format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: '' }
  };

  function makeState(options: {
    toolNameByProviderName?: Map<string, string>;
    functionNameByCallId?: Map<string, string>;
    userTranscript?: string;
    pendingUserTranscriptFinal?: boolean;
    userTranscriptFinalEmitted?: boolean;
    assistantTranscript?: string;
    assistantAudioInProgress?: boolean;
  } = {}) {
    return {
      audio,
      toolNameByProviderName: options.toolNameByProviderName ?? new Map(),
      functionNameByCallId: options.functionNameByCallId ?? new Map(),
      userTranscript: options.userTranscript ?? '',
      pendingUserTranscriptFinal: options.pendingUserTranscriptFinal ?? false,
      userTranscriptFinalEmitted: options.userTranscriptFinalEmitted ?? false,
      assistantTranscript: options.assistantTranscript ?? '',
      assistantAudioInProgress: options.assistantAudioInProgress ?? false
    } as any;
  }

  test('maps error', () => {
    const events = mapGrokRealtimeServerEvent({ type: 'error', error: { message: 'bad', code: 'x' } }, makeState());
    expect(events).toEqual([{ type: 'error', message: 'bad', code: 'x' }]);
  });

  test('handles missing event type and missing error message', () => {
    expect(mapGrokRealtimeServerEvent(undefined, makeState())).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'error', error: {} }, makeState())).toEqual([{ type: 'error', message: 'Realtime error' }]);
    expect(mapGrokRealtimeServerEvent({ type: 'error' }, makeState())).toEqual([{ type: 'error', message: 'Realtime error' }]);
  });

  test('maps error without code', () => {
    const events = mapGrokRealtimeServerEvent({ type: 'error', error: { message: 'bad' } }, makeState());
    expect(events).toEqual([{ type: 'error', message: 'bad' }]);
  });

  test('maps speech start/stop', () => {
    expect(mapGrokRealtimeServerEvent({ type: 'input_audio_buffer.speech_started' }, makeState())).toEqual([
      { type: 'user_speech.started' }
    ]);
    expect(mapGrokRealtimeServerEvent({ type: 'input_audio_buffer.speech_stopped' }, makeState())).toEqual([
      { type: 'user_speech.stopped' }
    ]);
  });

  test('maps user transcript delta', () => {
    expect(mapGrokRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hi' }, makeState())).toEqual([
      { type: 'user_transcript.delta', textDelta: 'hi' }
    ]);
    expect(mapGrokRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: '' }, makeState())).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.delta' }, makeState())).toEqual([]);
  });

  test('maps user transcript final (input audio transcription completed)', () => {
    const events = mapGrokRealtimeServerEvent(
      { type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' },
      makeState()
    );
    expect(events).toEqual([{ type: 'user_transcript.final', text: 'hello' }]);
  });

  test('drops empty user transcript final', () => {
    expect(mapGrokRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' }, makeState())).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.completed' }, makeState())).toEqual([]);
  });

  test('maps assistant audio delta/end', () => {
    const delta = mapGrokRealtimeServerEvent({ type: 'response.output_audio.delta', delta: 'AAA=' }, makeState());
    expect(delta).toEqual([
      {
        type: 'assistant_audio.chunk',
        frame: { format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AAA=' }
      }
    ]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_audio.done' }, makeState())).toEqual([{ type: 'assistant_audio.end' }]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_audio.delta', delta: '' }, makeState())).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_audio.delta' }, makeState())).toEqual([]);
  });

  test('maps assistant transcript delta', () => {
    const events = mapGrokRealtimeServerEvent({ type: 'response.output_audio_transcript.delta', delta: 'hi' }, makeState());
    expect(events).toEqual([{ type: 'assistant_transcript.delta', textDelta: 'hi' }]);
  });

  test('maps assistant transcript final (output audio transcript done)', () => {
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_audio_transcript.done', transcript: 'ok' }, makeState())).toEqual([
      { type: 'assistant_transcript.final', text: 'ok' }
    ]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_audio_transcript.delta', delta: '' }, makeState())).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_audio_transcript.done', transcript: '' }, makeState())).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_audio_transcript.delta' }, makeState())).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_audio_transcript.done' }, makeState())).toEqual([]);
  });

  test('response.done always emits a usage marker (with token counts when present)', () => {
    expect(mapGrokRealtimeServerEvent({ type: 'response.done' }, makeState())).toEqual([{ type: 'usage' }]);

    const withUsage = mapGrokRealtimeServerEvent(
      { type: 'response.done', response: { usage: { input_tokens: 1, output_tokens: 2 } } },
      makeState()
    )[0] as any;
    expect(withUsage.type).toBe('usage');
    expect(withUsage.inputTokens).toBe(1);
    expect(withUsage.outputTokens).toBe(2);
    expect(withUsage.metadata).toEqual({ input_tokens: 1, output_tokens: 2 });

    expect(mapGrokRealtimeServerEvent({ type: 'response.done', response: { usage: 'nope' } }, makeState())).toEqual([{ type: 'usage' }]);
  });

  test('response.done finalizes assistant transcript when transcript.done is missing', () => {
    const state = makeState();
    mapGrokRealtimeServerEvent({ type: 'response.output_audio_transcript.delta', delta: 'hi' }, state);
    mapGrokRealtimeServerEvent({ type: 'response.output_audio_transcript.delta', delta: ' there' }, state);

    const events = mapGrokRealtimeServerEvent({ type: 'response.done', response: {} }, state);
    expect(events).toEqual([
      { type: 'assistant_transcript.final', text: 'hi there' },
      { type: 'usage' }
    ]);
    expect(state.assistantTranscript).toBe('');
  });

  test('response.done does not re-emit assistant transcript final when transcript.done was received', () => {
    const state = makeState();
    mapGrokRealtimeServerEvent({ type: 'response.output_audio_transcript.delta', delta: 'hi' }, state);
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_audio_transcript.done', transcript: 'hi' }, state)).toEqual([
      { type: 'assistant_transcript.final', text: 'hi' }
    ]);
    expect(state.assistantTranscript).toBe('');

    expect(mapGrokRealtimeServerEvent({ type: 'response.done', response: {} }, state)).toEqual([{ type: 'usage' }]);
  });

  test('flushes pending user transcript final before assistant output begins', () => {
    const state = makeState();
    mapGrokRealtimeServerEvent({ type: 'input_audio_buffer.speech_started' }, state);
    mapGrokRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hello' }, state);
    mapGrokRealtimeServerEvent({ type: 'input_audio_buffer.speech_stopped' }, state);

    const events = mapGrokRealtimeServerEvent({ type: 'response.output_audio.delta', delta: 'AAA=' }, state);
    expect(events[0]).toEqual({ type: 'user_transcript.final', text: 'hello' });
    expect(events[1]).toEqual(
      expect.objectContaining({ type: 'assistant_audio.chunk' })
    );

    // Completed transcript arriving after the fallback final is ignored to avoid duplicates.
    expect(mapGrokRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' }, state)).toEqual([]);
  });

  test('flushes pending user transcript final at response.done when no assistant output occurred', () => {
    const state = makeState();
    mapGrokRealtimeServerEvent({ type: 'input_audio_buffer.speech_started' }, state);
    mapGrokRealtimeServerEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hi' }, state);
    mapGrokRealtimeServerEvent({ type: 'input_audio_buffer.speech_stopped' }, state);

    expect(mapGrokRealtimeServerEvent({ type: 'response.done', response: {} }, state)).toEqual([
      { type: 'user_transcript.final', text: 'hi' },
      { type: 'usage' }
    ]);
  });

  test('drops pending user transcript flush when final already emitted', () => {
    const state = makeState({
      userTranscript: 'hi',
      pendingUserTranscriptFinal: true,
      userTranscriptFinalEmitted: true
    });
    expect(mapGrokRealtimeServerEvent({ type: 'response.done', response: {} }, state)).toEqual([{ type: 'usage' }]);
    expect(state.pendingUserTranscriptFinal).toBe(false);
    expect(state.userTranscript).toBe('');
  });

  test('clears pending user transcript flush when there is no buffered text', () => {
    const state = makeState({
      userTranscript: '',
      pendingUserTranscriptFinal: true,
      userTranscriptFinalEmitted: false
    });
    expect(mapGrokRealtimeServerEvent({ type: 'response.done', response: {} }, state)).toEqual([{ type: 'usage' }]);
    expect(state.pendingUserTranscriptFinal).toBe(false);
    expect(state.userTranscriptFinalEmitted).toBe(false);
  });

  test('response.done emits assistant_audio.end when audio output never sent output_audio.done', () => {
    const state = makeState();
    mapGrokRealtimeServerEvent({ type: 'response.output_audio.delta', delta: 'AAA=' }, state);

    expect(mapGrokRealtimeServerEvent({ type: 'response.done', response: {} }, state)).toEqual([
      { type: 'assistant_audio.end' },
      { type: 'usage' }
    ]);
  });

  test('response.done(status=canceled) clears assistant transcript without emitting final', () => {
    const state = makeState({ assistantTranscript: 'partial' });
    expect(mapGrokRealtimeServerEvent({ type: 'response.done', response: { status: 'canceled' } }, state)).toEqual([{ type: 'usage' }]);
    expect(state.assistantTranscript).toBe('');
  });

  test('maps tool_call.start from response.output_item.added (function_call)', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']])
    });

    const events = mapGrokRealtimeServerEvent(
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1', name: 'test_echo' } },
      state
    );

    expect(events).toEqual([{ type: 'tool_call.start', toolCallId: 'c1', name: 'test.echo' }]);
    expect(state.functionNameByCallId.get('c1')).toBe('test.echo');
  });

  test('uses item.id when call_id is missing (response.output_item.added)', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']])
    });

    const events = mapGrokRealtimeServerEvent(
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'c1', name: 'test_echo' } },
      state
    );

    expect(events).toEqual([{ type: 'tool_call.start', toolCallId: 'c1', name: 'test.echo' }]);
  });

  test('ignores non-function_call output items', () => {
    const state = makeState();
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_item.added', item: { type: 'message' } }, state)).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.output_item.done', item: { type: 'message' } }, state)).toEqual([]);
  });

  test('drops tool_call.start when output_item.added is missing call_id or name', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']])
    });

    expect(
      mapGrokRealtimeServerEvent({ type: 'response.output_item.added', item: { type: 'function_call', call_id: '', name: 'test_echo' } }, state)
    ).toEqual([]);
    expect(
      mapGrokRealtimeServerEvent({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1', name: '' } }, state)
    ).toEqual([]);
    expect(
      mapGrokRealtimeServerEvent({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1' } }, state)
    ).toEqual([]);
    expect(
      mapGrokRealtimeServerEvent({ type: 'response.output_item.added', item: { type: 'function_call', name: 'test_echo' } }, state)
    ).toEqual([]);
  });

  test('maps tool_call.arguments_delta from response.function_call_arguments.delta', () => {
    const state = makeState();
    const events = mapGrokRealtimeServerEvent(
      { type: 'response.function_call_arguments.delta', call_id: 'c1', delta: '{"message":' },
      state
    );
    expect(events).toEqual([{ type: 'tool_call.arguments_delta', toolCallId: 'c1', jsonDelta: '{"message":' }]);
  });

  test('drops tool_call.arguments_delta when call_id or delta is missing', () => {
    const state = makeState();
    expect(mapGrokRealtimeServerEvent({ type: 'response.function_call_arguments.delta', call_id: '', delta: '{"x":' }, state)).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.function_call_arguments.delta', call_id: 'c1', delta: '' }, state)).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.function_call_arguments.delta', delta: '{"x":' }, state)).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.function_call_arguments.delta', call_id: 'c1' }, state)).toEqual([]);
  });

  test('maps tool_call.end from response.function_call_arguments.done and clears per-call tracking', () => {
    const state = makeState({
      functionNameByCallId: new Map([['c1', 'test.echo']])
    });

    const events = mapGrokRealtimeServerEvent(
      { type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '{"message":"Tokyo"}' },
      state
    );

    expect(events).toEqual([{ type: 'tool_call.end', toolCallId: 'c1', name: 'test.echo', arguments: { message: 'Tokyo' } }]);
    expect(state.functionNameByCallId.has('c1')).toBe(false);
  });

  test('maps tool_call.end with name=unknown when per-call name tracking is missing', () => {
    const state = makeState();
    const events = mapGrokRealtimeServerEvent(
      { type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '{"ok":true}' },
      state
    );
    expect(events).toEqual([{ type: 'tool_call.end', toolCallId: 'c1', name: 'unknown', arguments: { ok: true } }]);
  });

  test('drops tool_call.end when call_id or arguments is missing from response.function_call_arguments.done', () => {
    const state = makeState();
    expect(mapGrokRealtimeServerEvent({ type: 'response.function_call_arguments.done', call_id: '', arguments: '{}' }, state)).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.function_call_arguments.done', call_id: 'c1', arguments: '' }, state)).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.function_call_arguments.done', arguments: '{}' }, state)).toEqual([]);
    expect(mapGrokRealtimeServerEvent({ type: 'response.function_call_arguments.done', call_id: 'c1' }, state)).toEqual([]);
  });

  test('maps tool_call.end directly from response.output_item.done (function_call)', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']])
    });

    const events = mapGrokRealtimeServerEvent(
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'test_echo', arguments: '{"ok":true}' } },
      state
    );

    expect(events).toEqual([
      { type: 'tool_call.start', toolCallId: 'c1', name: 'test.echo' },
      { type: 'tool_call.end', toolCallId: 'c1', name: 'test.echo', arguments: { ok: true } }
    ]);
  });

  test('uses item.id when call_id is missing (response.output_item.done)', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']])
    });

    const events = mapGrokRealtimeServerEvent(
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'c1', name: 'test_echo', arguments: '{"ok":true}' } },
      state
    );

    expect(events).toEqual([
      { type: 'tool_call.start', toolCallId: 'c1', name: 'test.echo' },
      { type: 'tool_call.end', toolCallId: 'c1', name: 'test.echo', arguments: { ok: true } }
    ]);
  });

  test('drops response.output_item.done when call_id or name is missing', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']])
    });

    expect(
      mapGrokRealtimeServerEvent({ type: 'response.output_item.done', item: { type: 'function_call', call_id: '', name: 'test_echo', arguments: '{}' } }, state)
    ).toEqual([]);
    expect(
      mapGrokRealtimeServerEvent({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: '', arguments: '{}' } }, state)
    ).toEqual([]);
    expect(
      mapGrokRealtimeServerEvent({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', arguments: '{}' } }, state)
    ).toEqual([]);
    expect(
      mapGrokRealtimeServerEvent({ type: 'response.output_item.done', item: { type: 'function_call', name: 'test_echo', arguments: '{}' } }, state)
    ).toEqual([]);
  });

  test('treats missing/null/empty tool args as {}', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']])
    });

    const missing = mapGrokRealtimeServerEvent(
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'test_echo' } },
      state
    );
    expect(missing[1]).toEqual({ type: 'tool_call.end', toolCallId: 'c1', name: 'test.echo', arguments: {} });

    const nullArgs = mapGrokRealtimeServerEvent(
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c2', name: 'test_echo', arguments: null } },
      state
    );
    expect(nullArgs[1]).toEqual({ type: 'tool_call.end', toolCallId: 'c2', name: 'test.echo', arguments: {} });

    const emptyString = mapGrokRealtimeServerEvent(
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c3', name: 'test_echo', arguments: '' } },
      state
    );
    expect(emptyString[1]).toEqual({ type: 'tool_call.end', toolCallId: 'c3', name: 'test.echo', arguments: {} });
  });

  test('does not re-emit tool_call.start for output_item.done when call was already seen', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']]),
      functionNameByCallId: new Map([['c1', 'test.echo']])
    });

    const events = mapGrokRealtimeServerEvent(
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'test_echo', arguments: '{"ok":true}' } },
      state
    );

    expect(events).toEqual([{ type: 'tool_call.end', toolCallId: 'c1', name: 'test.echo', arguments: { ok: true } }]);
    expect(state.functionNameByCallId.has('c1')).toBe(false);
  });

  test('supports object tool args in response.output_item.done', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']])
    });

    const events = mapGrokRealtimeServerEvent(
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'test_echo', arguments: { ok: true } } },
      state
    );

    expect(events).toEqual([
      { type: 'tool_call.start', toolCallId: 'c1', name: 'test.echo' },
      { type: 'tool_call.end', toolCallId: 'c1', name: 'test.echo', arguments: { ok: true } }
    ]);
  });

  test('tool args must be a JSON object', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']])
    });
    expect(() =>
      mapGrokRealtimeServerEvent(
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'test_echo', arguments: '[]' } },
        state
      )
    ).toThrow('Tool arguments must be a JSON object');
  });

  test('throws when tool args is an array', () => {
    const state = makeState({
      toolNameByProviderName: new Map([['test_echo', 'test.echo']])
    });

    expect(() =>
      mapGrokRealtimeServerEvent(
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'test_echo', arguments: [] } },
        state
      )
    ).toThrow('Tool arguments must be a JSON object');
  });

  test('ignores unknown events', () => {
    expect(mapGrokRealtimeServerEvent({ type: 'nope' }, makeState())).toEqual([]);
  });
});
