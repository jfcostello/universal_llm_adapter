import type { UnifiedTool } from '@/modules/kernel/index.ts';
import {
  buildConversationItemCreateEvent,
  buildInputAudioAppendEvent,
  buildInputAudioCommitEvent,
  buildResponseCancelEvent,
  buildResponseCreateEvent,
  buildSessionUpdateEvent,
  buildToolResultItemCreateEvent
} from '@/plugins/realtime-compat/openai/internal/commands.ts';

describe('realtime-compat/openai — commands', () => {
  test('buildSessionUpdateEvent defaults audio to pcm16@24k mono and disables turn detection for manual_commit', () => {
    const { event, audio } = buildSessionUpdateEvent({
      spec: { provider: 'openai', model: 'm' }
    });

    expect(event.type).toBe('session.update');
    expect(event.session.type).toBe('realtime');
    expect(event.session.output_modalities).toEqual(['audio']);
    expect(event.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(event.session.audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(event.session.audio.input.turn_detection).toBe(null);

    expect(audio.input.format).toBe('pcm16');
    expect(audio.input.sampleRateHz).toBe(24000);
    expect(audio.input.channels).toBe(1);
  });

  test('buildSessionUpdateEvent applies systemPrompt, transcription, server_vad, tools and toolChoice', () => {
    const tools: UnifiedTool[] = [
      { name: 'test.echo', description: 'Echo', parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } } } }
    ];

    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        systemPrompt: 'Hello',
        transcription: { enabled: true, language: 'en' },
        turnDetection: { mode: 'server_vad' },
        toolChoice: { type: 'single', name: 'test.echo' }
      },
      tools
    });

    expect(event.session.instructions).toBe('Hello');
    expect(event.session.audio.input.transcription.model).toBe('whisper-1');
    expect(event.session.audio.input.transcription.language).toBe('en');
    expect(event.session.audio.input.turn_detection.type).toBe('server_vad');
    expect(Array.isArray(event.session.tools)).toBe(true);
    expect(event.session.tools[0].name).toBe('test.echo');
    expect(event.session.tool_choice).toEqual({ type: 'function', name: 'test.echo' });
  });

  test('buildSessionUpdateEvent supplies default JSON schema when tool parameters are missing', () => {
    const tools: UnifiedTool[] = [{ name: 'test.noSchema' }];
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'openai', model: 'm' },
      tools
    });
    expect(event.session.tools[0].parameters).toEqual({ type: 'object', properties: {} });
  });

  test('buildSessionUpdateEvent supports transcription without language', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        transcription: { enabled: true }
      }
    });
    expect(event.session.audio.input.transcription.model).toBe('whisper-1');
    expect(event.session.audio.input.transcription.language).toBeUndefined();
  });

  test('buildSessionUpdateEvent validates audio constraints (channels and sample rates)', () => {
    expect(() =>
      buildSessionUpdateEvent({
        spec: {
          provider: 'openai',
          model: 'm',
          audio: { input: { format: 'pcm16', sampleRateHz: 24000, channels: 2 } }
        }
      })
    ).toThrow('channels=1');

    expect(() =>
      buildSessionUpdateEvent({
        spec: {
          provider: 'openai',
          model: 'm',
          audio: { input: { format: 'pcm16', sampleRateHz: 16000, channels: 1 } }
        }
      })
    ).toThrow('pcm16 requires sampleRateHz=24000');

    expect(() =>
      buildSessionUpdateEvent({
        spec: {
          provider: 'openai',
          model: 'm',
          audio: { input: { format: 'g711_ulaw', sampleRateHz: 24000, channels: 1 } }
        }
      })
    ).toThrow('g711_ulaw requires sampleRateHz=8000');

    expect(() =>
      buildSessionUpdateEvent({
        spec: {
          provider: 'openai',
          model: 'm',
          audio: { input: { format: 'g711_alaw', sampleRateHz: 24000, channels: 1 } }
        }
      })
    ).toThrow('g711_alaw requires sampleRateHz=8000');
  });

  test('buildSessionUpdateEvent falls back audio input/output when only one side is provided', () => {
    const onlyInput = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        audio: { input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 } }
      }
    });
    expect(onlyInput.audio.output.format).toBe('pcm16');

    const onlyOutput = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        audio: { output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 } }
      }
    });
    expect(onlyOutput.audio.input.format).toBe('pcm16');
  });

  test('buildSessionUpdateEvent supports g711 formats', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        audio: {
          input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
          output: { format: 'g711_alaw', sampleRateHz: 8000, channels: 1 }
        }
      }
    });

    expect(event.session.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(event.session.audio.output.format).toEqual({ type: 'audio/pcma' });
  });

  test('buildSessionUpdateEvent serializes required tool choice', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        toolChoice: { type: 'required', allowed: ['test.echo'] }
      }
    });
    expect(event.session.tool_choice).toBe('required');
  });

  test('buildSessionUpdateEvent serializes string tool choices', () => {
    const none = buildSessionUpdateEvent({
      spec: { provider: 'openai', model: 'm', toolChoice: 'none' }
    });
    expect(none.event.session.tool_choice).toBe('none');
  });

  test('buildSessionUpdateEvent drops unknown tool choice objects', () => {
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'openai', model: 'm', toolChoice: { type: 'weird' } as any }
    });
    expect(event.session.tool_choice).toBeUndefined();
  });

  test('buildSessionUpdateEvent rejects unsupported audio formats', () => {
    expect(() =>
      buildSessionUpdateEvent({
        spec: {
          provider: 'openai',
          model: 'm',
          audio: { input: { format: 'nope' as any, sampleRateHz: 24000, channels: 1 } }
        }
      })
    ).toThrow('Unsupported audio format');
  });

  test('buildConversationItemCreateEvent produces message item', () => {
    const evt = buildConversationItemCreateEvent({ text: 'hi', role: 'user' });
    expect(evt.type).toBe('conversation.item.create');
    expect(evt.item.type).toBe('message');
    expect(evt.item.role).toBe('user');
    expect(evt.item.content[0]).toEqual({ type: 'input_text', text: 'hi' });
  });

  test('audio append/commit/response/cancel events serialize with expected types', () => {
    expect(buildInputAudioAppendEvent({ format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AAA=' }).type).toBe(
      'input_audio_buffer.append'
    );
    expect(buildInputAudioCommitEvent().type).toBe('input_audio_buffer.commit');
    expect(buildResponseCreateEvent().type).toBe('response.create');
    expect(buildResponseCancelEvent().type).toBe('response.cancel');
  });

  test('tool result item serializes string and JSON results', () => {
    const asString = buildToolResultItemCreateEvent({ toolCallId: 'c1', result: 'ok' });
    expect(asString.item.output).toBe('ok');

    const asJson = buildToolResultItemCreateEvent({ toolCallId: 'c2', result: { a: 1 } });
    expect(asJson.item.output).toBe(JSON.stringify({ a: 1 }));
  });
});
