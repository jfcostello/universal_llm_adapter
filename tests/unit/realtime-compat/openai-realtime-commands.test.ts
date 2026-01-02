import type { UnifiedTool } from '@/kernel/index.ts';
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
    expect(event.session.audio.input.turn_detection.create_response).toBe(true);
    expect(event.session.audio.input.turn_detection.interrupt_response).toBe(false);
    expect(Array.isArray(event.session.tools)).toBe(true);
    expect(event.session.tools).toHaveLength(1);
    expect(event.session.tools[0].name).toBe('test_echo');
    expect(event.session.tool_choice).toBe('auto');
  });

  test('buildSessionUpdateEvent supplies default JSON schema when tool parameters are missing', () => {
    const tools: UnifiedTool[] = [{ name: 'test.noSchema' }];
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'openai', model: 'm' },
      tools
    });
    expect(event.session.tools[0].parameters).toEqual({ type: 'object', properties: {} });
    expect(event.session.tool_choice).toBe('auto');
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

  test('buildSessionUpdateEvent maps session settings (voice, temperature) and reports unknown/invalid keys', () => {
    const { event, settingsWarnings } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        settings: { voice: 'voice_1', temperature: 0.7, extra: true, badVoice: '' } as any
      }
    });

    expect(event.session.voice).toBe('voice_1');
    expect(event.session.temperature).toBe(0.7);
    expect(settingsWarnings.unknownKeys.sort()).toEqual(['badVoice', 'extra']);
    expect(settingsWarnings.invalidKeys).toEqual([]);
  });

  test('buildSessionUpdateEvent ignores invalid typed session settings', () => {
    const { event, settingsWarnings } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        settings: { voice: '   ', temperature: 'nope' } as any
      }
    });

    expect(event.session.voice).toBeUndefined();
    expect(event.session.temperature).toBeUndefined();
    expect(settingsWarnings.unknownKeys).toEqual([]);
    expect(settingsWarnings.invalidKeys.sort()).toEqual(['temperature', 'voice']);
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
    const tools: UnifiedTool[] = [{ name: 'test.echo' }];
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        toolChoice: { type: 'required', allowed: ['test.echo'] }
      },
      tools
    });
    expect(event.session.tool_choice).toBe('required');
    expect(event.session.tools.map((t: any) => t.name)).toEqual(['test_echo']);
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

  test('buildSessionUpdateEvent rejects toolChoice objects when no tools are configured', () => {
    expect(() =>
      buildSessionUpdateEvent({
        spec: { provider: 'openai', model: 'm', toolChoice: { type: 'single', name: 'unmapped_tool' } }
      })
    ).toThrow('no tools');
  });

  test('buildSessionUpdateEvent sanitizes tool names and de-dupes collisions', () => {
    const tools: UnifiedTool[] = [
      { name: 'a.b' },
      { name: 'a_b' },
      { name: '' }
    ];

    const { event, toolNameByProviderName } = buildSessionUpdateEvent({
      spec: { provider: 'openai', model: 'm' },
      tools
    });

    expect(event.session.tools.map((t: any) => t.name)).toEqual(['a_b', 'a_b_2', 'tool']);
    expect(toolNameByProviderName.get('a_b')).toBe('a.b');
    expect(toolNameByProviderName.get('a_b_2')).toBe('a_b');
    expect(toolNameByProviderName.get('tool')).toBe('');
  });

  test('buildSessionUpdateEvent filters tools for toolChoice.required allowed list', () => {
    const tools: UnifiedTool[] = [{ name: 'test.one' }, { name: 'test.two' }];

    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        toolChoice: { type: 'required', allowed: ['test.one'] }
      },
      tools
    });

    expect(event.session.tool_choice).toBe('required');
    expect(event.session.tools.map((t: any) => t.name)).toEqual(['test_one']);
  });

  test('buildSessionUpdateEvent rejects toolChoice.single when tool is missing from configured tools', () => {
    const tools: UnifiedTool[] = [{ name: 'test.present' }];

    expect(() =>
      buildSessionUpdateEvent({
        spec: { provider: 'openai', model: 'm', toolChoice: { type: 'single', name: 'test.missing' } },
        tools
      })
    ).toThrow('unknown tool');
  });

  test('buildSessionUpdateEvent rejects toolChoice.required allowed list when none match configured tools', () => {
    const tools: UnifiedTool[] = [{ name: 'test.present' }];

    expect(() =>
      buildSessionUpdateEvent({
        spec: { provider: 'openai', model: 'm', toolChoice: { type: 'required', allowed: ['test.missing'] } },
        tools
      })
    ).toThrow('no allowed tools');
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

  test('buildConversationItemCreateEvent produces message item for user/system roles', () => {
    const userEvt = buildConversationItemCreateEvent({ text: 'hi', role: 'user' });
    expect(userEvt.type).toBe('conversation.item.create');
    expect(userEvt.item.type).toBe('message');
    expect(userEvt.item.role).toBe('user');
    expect(userEvt.item.content[0]).toEqual({ type: 'input_text', text: 'hi' });

    const systemEvt = buildConversationItemCreateEvent({ text: 'sys', role: 'system' });
    expect(systemEvt.item.role).toBe('system');
    expect(systemEvt.item.content[0]).toEqual({ type: 'input_text', text: 'sys' });
  });

  test('buildConversationItemCreateEvent produces assistant message item with text content', () => {
    const evt = buildConversationItemCreateEvent({ text: 'hello', role: 'assistant' });
    expect(evt.type).toBe('conversation.item.create');
    expect(evt.item.type).toBe('message');
    expect(evt.item.role).toBe('assistant');
    expect(evt.item.content[0]).toEqual({ type: 'text', text: 'hello' });
  });

  test('audio append/commit/response/cancel events serialize with expected types', () => {
    expect(buildInputAudioAppendEvent({ format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AAA=' }).type).toBe(
      'input_audio_buffer.append'
    );
    expect(buildInputAudioCommitEvent().type).toBe('input_audio_buffer.commit');
    expect(buildResponseCreateEvent().type).toBe('response.create');
    expect(buildResponseCreateEvent({ toolChoice: 'required' })).toEqual({ type: 'response.create', response: { tool_choice: 'required' } });
    expect(buildResponseCancelEvent().type).toBe('response.cancel');
  });

  test('tool result item serializes string and JSON results', () => {
    const asString = buildToolResultItemCreateEvent({ toolCallId: 'c1', result: 'ok' });
    expect(asString.item.output).toBe('ok');

    const asJson = buildToolResultItemCreateEvent({ toolCallId: 'c2', result: { a: 1 } });
    expect(asJson.item.output).toBe(JSON.stringify({ a: 1 }));
  });

  // Extended settings tests (Issue #812)

  test('buildSessionUpdateEvent maps extended settings (speed, maxResponseOutputTokens)', () => {
    const { event, settingsWarnings } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        settings: {
          speed: 1.5,
          maxResponseOutputTokens: '4096'
        } as any
      }
    });

    expect(event.session.speed).toBe(1.5);
    expect(event.session.max_response_output_tokens).toBe('4096');
    expect(settingsWarnings.unknownKeys).toEqual([]);
    expect(settingsWarnings.invalidKeys).toEqual([]);
  });

  test('buildSessionUpdateEvent maps maxResponseOutputTokens via alias', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        settings: { max_response_output_tokens: '2048' } as any
      }
    });

    expect(event.session.max_response_output_tokens).toBe('2048');
  });

  test('buildSessionUpdateEvent uses custom transcriptionModel instead of whisper-1', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        transcription: { enabled: true, language: 'en' },
        settings: { transcription_model: 'gpt-4o-transcribe' } as any
      }
    });

    expect(event.session.audio.input.transcription.model).toBe('gpt-4o-transcribe');
    expect(event.session.audio.input.transcription.language).toBe('en');
  });

  test('buildSessionUpdateEvent applies noiseReduction setting', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        settings: { noise_reduction: 'near_field' } as any
      }
    });

    expect(event.session.audio.input.noise_reduction).toEqual({ type: 'near_field' });
  });

  test('buildSessionUpdateEvent reports invalid vadType values and defaults to server_vad', () => {
    const { event, settingsWarnings } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        turnDetection: { mode: 'server_vad' },
        settings: { vad_type: 'nope' } as any
      }
    });

    expect(event.session.audio.input.turn_detection.type).toBe('server_vad');
    expect(settingsWarnings.invalidKeys).toEqual(['vad_type']);
  });

  test('buildSessionUpdateEvent falls back to canonical invalid key when settings key is missing post-parse', () => {
    const settings: any = {};
    Object.defineProperty(settings, 'vad_type', {
      configurable: true,
      enumerable: true,
      get() {
        delete settings.vad_type;
        return 'nope';
      }
    });

    const { event, settingsWarnings } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        turnDetection: { mode: 'server_vad' },
        settings
      } as any
    });

    expect(event.session.audio.input.turn_detection.type).toBe('server_vad');
    expect(settingsWarnings.invalidKeys).toEqual(['vadType']);
  });

  test('buildSessionUpdateEvent supports semantic_vad with eagerness setting', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        turnDetection: { mode: 'server_vad' },
        settings: { vad_type: 'semantic_vad', vad_eagerness: 'low' } as any
      }
    });

    expect(event.session.audio.input.turn_detection.type).toBe('semantic_vad');
    expect(event.session.audio.input.turn_detection.eagerness).toBe('low');
    expect(event.session.audio.input.turn_detection.create_response).toBe(true);
    expect(event.session.audio.input.turn_detection.interrupt_response).toBe(false);
    // Threshold/padding should not be present for semantic_vad
    expect(event.session.audio.input.turn_detection.threshold).toBeUndefined();
    expect(event.session.audio.input.turn_detection.prefix_padding_ms).toBeUndefined();
  });

  test('buildSessionUpdateEvent reports invalid vadEagerness values and omits eagerness', () => {
    const { event, settingsWarnings } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        turnDetection: { mode: 'server_vad' },
        settings: { vad_type: 'semantic_vad', vad_eagerness: 'nope' } as any
      }
    });

    expect(event.session.audio.input.turn_detection.type).toBe('semantic_vad');
    expect(event.session.audio.input.turn_detection.eagerness).toBeUndefined();
    expect(settingsWarnings.invalidKeys).toEqual(['vad_eagerness']);
  });

  test('buildSessionUpdateEvent supports semantic_vad without eagerness setting', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        turnDetection: { mode: 'server_vad' },
        settings: { vad_type: 'semantic_vad' } as any
      }
    });

    expect(event.session.audio.input.turn_detection.type).toBe('semantic_vad');
    expect(event.session.audio.input.turn_detection.eagerness).toBeUndefined();
    expect(event.session.audio.input.turn_detection.create_response).toBe(true);
    expect(event.session.audio.input.turn_detection.interrupt_response).toBe(false);
  });

  test('buildSessionUpdateEvent applies server_vad threshold and padding settings', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        turnDetection: { mode: 'server_vad' },
        settings: {
          vadThreshold: 0.6,
          vad_prefix_padding_ms: 300,
          vad_silence_duration_ms: 500,
          vad_idle_timeout_ms: 1000
        } as any
      }
    });

    expect(event.session.audio.input.turn_detection.type).toBe('server_vad');
    expect(event.session.audio.input.turn_detection.threshold).toBe(0.6);
    expect(event.session.audio.input.turn_detection.prefix_padding_ms).toBe(300);
    expect(event.session.audio.input.turn_detection.silence_duration_ms).toBe(500);
    expect(event.session.audio.input.turn_detection.idle_timeout_ms).toBe(1000);
    // Eagerness should not be present for server_vad
    expect(event.session.audio.input.turn_detection.eagerness).toBeUndefined();
  });

  test('buildSessionUpdateEvent defaults to server_vad when vadType is not semantic_vad', () => {
    const { event: defaultVad } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        turnDetection: { mode: 'server_vad' }
      }
    });
    expect(defaultVad.session.audio.input.turn_detection.type).toBe('server_vad');

    const { event: explicitServerVad } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        turnDetection: { mode: 'server_vad' },
        settings: { vad_type: 'server_vad' } as any
      }
    });
    expect(explicitServerVad.session.audio.input.turn_detection.type).toBe('server_vad');
  });

  test('buildSessionUpdateEvent ignores VAD settings when turnDetection mode is manual_commit', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        turnDetection: { mode: 'manual_commit' },
        settings: {
          vad_type: 'semantic_vad',
          vadThreshold: 0.5,
          vad_eagerness: 'high'
        } as any
      }
    });

    // Turn detection should be null for manual_commit mode
    expect(event.session.audio.input.turn_detection).toBe(null);
  });

  test('buildSessionUpdateEvent combines all extended settings correctly', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'openai',
        model: 'm',
        systemPrompt: 'Be helpful',
        transcription: { enabled: true, language: 'en' },
        turnDetection: { mode: 'server_vad' },
        settings: {
          voice: 'marin',
          temperature: 0.8,
          speed: 1.2,
          max_response_output_tokens: 'inf',
          transcription_model: 'gpt-4o-transcribe',
          noise_reduction: 'near_field',
          vad_threshold: 0.5,
          vad_prefix_padding_ms: 250,
          vad_silence_duration_ms: 400
        } as any
      }
    });

    expect(event.session.voice).toBe('marin');
    expect(event.session.temperature).toBe(0.8);
    expect(event.session.speed).toBe(1.2);
    expect(event.session.max_response_output_tokens).toBe('inf');
    expect(event.session.audio.input.noise_reduction).toEqual({ type: 'near_field' });
    expect(event.session.audio.input.transcription.model).toBe('gpt-4o-transcribe');
    expect(event.session.audio.input.turn_detection.type).toBe('server_vad');
    expect(event.session.audio.input.turn_detection.threshold).toBe(0.5);
    expect(event.session.audio.input.turn_detection.prefix_padding_ms).toBe(250);
    expect(event.session.audio.input.turn_detection.silence_duration_ms).toBe(400);
  });
});
