import type { UnifiedTool } from '@/kernel/index.ts';
import {
  buildConversationItemCreateEvent,
  buildResponseCreateEvent,
  buildSessionUpdateEvent,
  buildToolResultItemCreateEvent
} from '@/plugins/realtime-compat/grok/internal/commands.ts';

describe('realtime-compat/grok — commands', () => {
  test('buildSessionUpdateEvent defaults audio to pcm16@24k mono and uses default voice', () => {
    const { event, audio } = buildSessionUpdateEvent({
      spec: { provider: 'grok' },
      defaultVoice: 'ara'
    });

    expect(event.type).toBe('session.update');
    expect(event.session.instructions).toBeUndefined();
    expect(event.session.voice).toBe('ara');
    expect(event.session.turn_detection).toBe(null);
    expect(event.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(event.session.audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });

    expect(audio.input.format).toBe('pcm16');
    expect(audio.input.sampleRateHz).toBe(24000);
    expect(audio.input.channels).toBe(1);
  });

  test('buildSessionUpdateEvent includes system prompt instructions when provided', () => {
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok', systemPrompt: 'be helpful' },
      defaultVoice: 'ara'
    });

    expect(event.session.instructions).toBe('be helpful');
  });

  test('buildSessionUpdateEvent supports voice override via spec.metadata.voice', () => {
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok', metadata: { voice: 'rex' } },
      defaultVoice: 'ara'
    });
    expect(event.session.voice).toBe('rex');
  });

  test('buildSessionUpdateEvent prefers spec.settings.voice over spec.metadata.voice', () => {
    const { event, settingsWarnings } = buildSessionUpdateEvent({
      spec: { provider: 'grok', settings: { voice: 's1' }, metadata: { voice: 'm1' } } as any,
      defaultVoice: 'ara'
    });
    expect(event.session.voice).toBe('s1');
    expect(settingsWarnings.unknownKeys).toEqual([]);
    expect(settingsWarnings.invalidKeys).toEqual([]);
  });

  test('buildSessionUpdateEvent maps temperature and reports unknown/invalid keys', () => {
    const { event, settingsWarnings } = buildSessionUpdateEvent({
      spec: { provider: 'grok', settings: { temperature: 0.9, extra: true } } as any,
      defaultVoice: 'ara'
    });
    expect(event.session.temperature).toBe(0.9);
    expect(settingsWarnings.unknownKeys).toEqual(['extra']);
    expect(settingsWarnings.invalidKeys).toEqual([]);
  });

  test('buildSessionUpdateEvent ignores invalid typed session settings', () => {
    const { event, settingsWarnings } = buildSessionUpdateEvent({
      spec: { provider: 'grok', settings: { voice: '   ', temperature: 'nope' } } as any,
      defaultVoice: 'ara'
    });
    expect(event.session.voice).toBe('ara');
    expect(event.session.temperature).toBeUndefined();
    expect(settingsWarnings.unknownKeys).toEqual([]);
    expect(settingsWarnings.invalidKeys.sort()).toEqual(['temperature', 'voice']);
  });

  test('buildSessionUpdateEvent trims voice override and falls back to default voice when override is empty', () => {
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok', metadata: { voice: '   ' } },
      defaultVoice: '  ara  '
    });

    expect(event.session.voice).toBe('ara');
  });

  test('buildSessionUpdateEvent omits voice when neither override nor default voice are provided', () => {
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok' },
      defaultVoice: '  '
    });

    expect(event.session.voice).toBeUndefined();
  });

  test('buildSessionUpdateEvent supports server_vad turn detection', () => {
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok', turnDetection: { mode: 'server_vad' } },
      defaultVoice: 'ara'
    });
    expect(event.session.turn_detection.type).toBe('server_vad');
  });

  test('buildSessionUpdateEvent supports g711 formats', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        audio: {
          input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
          output: { format: 'g711_alaw', sampleRateHz: 8000, channels: 1 }
        }
      },
      defaultVoice: 'ara'
    });

    expect(event.session.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(event.session.audio.output.format).toEqual({ type: 'audio/pcma' });
  });

  test('buildSessionUpdateEvent uses output audio config when only output is provided', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        audio: {
          output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
        }
      },
      defaultVoice: 'ara'
    });

    expect(event.session.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(event.session.audio.output.format).toEqual({ type: 'audio/pcmu' });
  });

  test('buildSessionUpdateEvent validates audio config (channels, sample rate, and format)', () => {
    expect(() =>
      buildSessionUpdateEvent({
        spec: { provider: 'grok', audio: { input: { format: 'pcm16', sampleRateHz: 24000, channels: 2 } } } as any,
        defaultVoice: 'ara'
      })
    ).toThrow('Only mono audio (channels=1) is supported');

    expect(() =>
      buildSessionUpdateEvent({
        spec: { provider: 'grok', audio: { input: { format: 'pcm16', sampleRateHz: 0, channels: 1 } } } as any,
        defaultVoice: 'ara'
      })
    ).toThrow('pcm16 requires a positive sampleRateHz');

    expect(() =>
      buildSessionUpdateEvent({
        spec: { provider: 'grok', audio: { input: { format: 'g711_ulaw', sampleRateHz: 16000, channels: 1 } } } as any,
        defaultVoice: 'ara'
      })
    ).toThrow('g711_ulaw requires sampleRateHz=8000');

    expect(() =>
      buildSessionUpdateEvent({
        spec: { provider: 'grok', audio: { input: { format: 'mp3', sampleRateHz: 8000, channels: 1 } } } as any,
        defaultVoice: 'ara'
      })
    ).toThrow('Unsupported audio format: mp3');
  });

  test('buildSessionUpdateEvent serializes tools (OpenAI-realtime style)', () => {
    const tools: UnifiedTool[] = [
      { name: 'test.echo', description: 'Echo', parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } } } }
    ];

    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok' },
      defaultVoice: 'ara',
      tools
    });

    expect(Array.isArray(event.session.tools)).toBe(true);
    expect(event.session.tools).toHaveLength(1);
    expect(event.session.tools[0].type).toBe('function');
    expect(event.session.tools[0].name).toBe('test_echo');
    expect(event.session.tools[0].parameters).toEqual({ type: 'object', properties: { message: { type: 'string' } } });
  });

  test('buildSessionUpdateEvent supports empty tools list (omits tools/tool_choice)', () => {
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok' },
      defaultVoice: 'ara',
      tools: []
    });

    expect(event.session.tools).toBeUndefined();
    expect(event.session.tool_choice).toBeUndefined();
  });

  test('buildSessionUpdateEvent supports toolChoice=none (keeps tools but sets tool_choice)', () => {
    const tools: UnifiedTool[] = [
      { name: 'test.echo', description: 'Echo', parametersJsonSchema: { type: 'object', properties: {} } }
    ];

    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok', toolChoice: 'none' },
      defaultVoice: 'ara',
      tools
    });

    expect(event.session.tools).toHaveLength(1);
    expect(event.session.tool_choice).toBe('none');
  });

  test('buildSessionUpdateEvent drops unknown toolChoice objects', () => {
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok', toolChoice: { type: 'weird' } as any },
      defaultVoice: 'ara'
    });

    expect(event.session.tool_choice).toBeUndefined();
  });

  test('buildSessionUpdateEvent supports toolChoice.single by filtering tools and omitting session tool_choice', () => {
    const tools: UnifiedTool[] = [
      { name: 'test.echo', description: 'Echo', parametersJsonSchema: { type: 'object', properties: {} } },
      { name: 'test.sum', description: 'Sum', parametersJsonSchema: { type: 'object', properties: {} } }
    ];

    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok', toolChoice: { type: 'single', name: 'test.sum' } },
      defaultVoice: 'ara',
      tools
    });

    expect(event.session.tools).toHaveLength(1);
    expect(event.session.tools[0].name).toBe('test_sum');
    expect(event.session.tool_choice).toBe('auto');
  });

  test('buildSessionUpdateEvent rejects toolChoice.single when tool is missing from configured tools', () => {
    const tools: UnifiedTool[] = [{ name: 'test.present', description: 'Present' }];

    expect(() =>
      buildSessionUpdateEvent({
        spec: { provider: 'grok', toolChoice: { type: 'single', name: 'test.missing' } },
        defaultVoice: 'ara',
        tools
      })
    ).toThrow('unknown tool');
  });

  test('buildSessionUpdateEvent supports toolChoice.required by filtering allowed tools and setting tool_choice=required', () => {
    const tools: UnifiedTool[] = [
      { name: 'test.echo', description: 'Echo', parametersJsonSchema: { type: 'object', properties: {} } },
      { name: 'test.sum', description: 'Sum', parametersJsonSchema: { type: 'object', properties: {} } }
    ];

    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok', toolChoice: { type: 'required', allowed: ['test.echo'] } },
      defaultVoice: 'ara',
      tools
    });

    expect(event.session.tools).toHaveLength(1);
    expect(event.session.tools[0].name).toBe('test_echo');
    expect(event.session.tool_choice).toBe('required');
  });

  test('buildSessionUpdateEvent rejects toolChoice.required allowed list when none match configured tools', () => {
    const tools: UnifiedTool[] = [{ name: 'test.present', description: 'Present' }];

    expect(() =>
      buildSessionUpdateEvent({
        spec: { provider: 'grok', toolChoice: { type: 'required', allowed: ['test.missing'] } },
        defaultVoice: 'ara',
        tools
      })
    ).toThrow('no allowed tools');
  });

  test('buildSessionUpdateEvent throws when toolChoice is provided but no tools are configured', () => {
    expect(() =>
      buildSessionUpdateEvent({
        spec: { provider: 'grok', toolChoice: { type: 'single', name: 'test.echo' } } as any,
        defaultVoice: 'ara',
        tools: []
      })
    ).toThrow('toolChoice provided but no tools are configured');
  });

  test('buildSessionUpdateEvent deduplicates provider tool names and applies fallback schema', () => {
    const tools: UnifiedTool[] = [
      { name: 'a.b', description: 'A', parametersJsonSchema: { type: 'object', properties: {} } },
      { name: 'a_b', description: 'B' } as any
    ];

    const { event, toolNameByProviderName } = buildSessionUpdateEvent({
      spec: { provider: 'grok' },
      defaultVoice: 'ara',
      tools
    });

    expect(event.session.tools.map((t: any) => t.name)).toEqual(['a_b', 'a_b_2']);
    expect(toolNameByProviderName.get('a_b')).toBe('a.b');
    expect(toolNameByProviderName.get('a_b_2')).toBe('a_b');

    expect(event.session.tools[1].parameters).toEqual({ type: 'object', properties: {} });
  });

  test('buildSessionUpdateEvent uses fallback provider tool name when tool name is empty', () => {
    const tools: UnifiedTool[] = [{ name: '', description: 'Empty name tool' } as any];
    const { event } = buildSessionUpdateEvent({
      spec: { provider: 'grok' },
      defaultVoice: 'ara',
      tools
    });

    expect(event.session.tools[0].name).toBe('tool');
  });

  test('buildConversationItemCreateEvent uses correct content type by role', () => {
    expect(buildConversationItemCreateEvent({ text: 'hi', role: 'assistant' }).item.content[0].type).toBe('text');
    expect(buildConversationItemCreateEvent({ text: 'hi', role: 'user' }).item.content[0].type).toBe('input_text');
    expect(buildConversationItemCreateEvent({ text: 'hi', role: 'system' }).item.content[0].type).toBe('input_text');
  });

  test('buildResponseCreateEvent includes tool_choice when provided', () => {
    const base = buildResponseCreateEvent();
    expect(base.response?.modalities).toEqual(['text', 'audio']);
    expect(base.response?.tool_choice).toBeUndefined();

    const forced = buildResponseCreateEvent({ toolChoice: 'required' });
    expect(forced.response?.modalities).toEqual(['text', 'audio']);
    expect(forced.response?.tool_choice).toBe('required');
  });

  test('buildToolResultItemCreateEvent serializes string and JSON results', () => {
    expect(buildToolResultItemCreateEvent({ toolCallId: 'call-1', result: 'ok' }).item.output).toBe('ok');
    expect(buildToolResultItemCreateEvent({ toolCallId: 'call-1', result: { ok: true } }).item.output).toBe('{"ok":true}');
  });

  // Extended settings tests (Issue #812)

  test('buildSessionUpdateEvent applies VAD settings in server_vad mode', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        turnDetection: { mode: 'server_vad' },
        settings: {
          vad_threshold: 0.6,
          vad_prefix_padding_ms: 250,
          vad_silence_duration_ms: 400
        } as any
      },
      defaultVoice: 'ara'
    });

    expect(event.session.turn_detection.type).toBe('server_vad');
    expect(event.session.turn_detection.threshold).toBe(0.6);
    expect(event.session.turn_detection.prefix_padding_ms).toBe(250);
    expect(event.session.turn_detection.silence_duration_ms).toBe(400);
  });

  test('buildSessionUpdateEvent applies VAD settings via camelCase aliases', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        turnDetection: { mode: 'server_vad' },
        settings: {
          vadThreshold: 0.5,
          vadPrefixPaddingMs: 300,
          vadSilenceDurationMs: 500
        } as any
      },
      defaultVoice: 'ara'
    });

    expect(event.session.turn_detection.threshold).toBe(0.5);
    expect(event.session.turn_detection.prefix_padding_ms).toBe(300);
    expect(event.session.turn_detection.silence_duration_ms).toBe(500);
  });

  test('buildSessionUpdateEvent ignores VAD settings in manual_commit mode', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        turnDetection: { mode: 'manual_commit' },
        settings: {
          vadThreshold: 0.5,
          vad_prefix_padding_ms: 300
        } as any
      },
      defaultVoice: 'ara'
    });

    expect(event.session.turn_detection).toBe(null);
  });

  test('buildSessionUpdateEvent injects web_search built-in tool when enabled', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        settings: { enable_web_search: 'true' } as any
      },
      defaultVoice: 'ara'
    });

    expect(event.session.tools).toEqual([{ type: 'web_search' }]);
    expect(event.session.tool_choice).toBe('auto');
  });

  test('buildSessionUpdateEvent injects x_search built-in tool when enabled', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        settings: { enableXSearch: true } as any
      },
      defaultVoice: 'ara'
    });

    expect(event.session.tools).toEqual([{ type: 'x_search' }]);
    expect(event.session.tool_choice).toBe('auto');
  });

  test('buildSessionUpdateEvent injects file_search built-in tool when enabled', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        settings: { enable_file_search: 'yes' } as any
      },
      defaultVoice: 'ara'
    });

    expect(event.session.tools).toEqual([{ type: 'file_search' }]);
    expect(event.session.tool_choice).toBe('auto');
  });

  test('buildSessionUpdateEvent combines function tools with built-in tools', () => {
    const tools: UnifiedTool[] = [
      { name: 'test.echo', description: 'Echo', parametersJsonSchema: { type: 'object', properties: {} } }
    ];

    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        settings: {
          enableWebSearch: true,
          enableXSearch: true
        } as any
      },
      defaultVoice: 'ara',
      tools
    });

    expect(event.session.tools).toHaveLength(3);
    expect(event.session.tools[0].type).toBe('function');
    expect(event.session.tools[0].name).toBe('test_echo');
    expect(event.session.tools[1]).toEqual({ type: 'web_search' });
    expect(event.session.tools[2]).toEqual({ type: 'x_search' });
    expect(event.session.tool_choice).toBe('auto');
  });

  test('buildSessionUpdateEvent does not inject built-in tools when disabled', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        settings: {
          enableWebSearch: false,
          enableXSearch: 'no',
          enableFileSearch: 'off'
        } as any
      },
      defaultVoice: 'ara'
    });

    expect(event.session.tools).toBeUndefined();
    expect(event.session.tool_choice).toBeUndefined();
  });

  test('buildSessionUpdateEvent injects multiple built-in tools when all enabled', () => {
    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        settings: {
          enable_web_search: 'true',
          enable_x_search: 'true',
          enable_file_search: 'true'
        } as any
      },
      defaultVoice: 'ara'
    });

    expect(event.session.tools).toHaveLength(3);
    expect(event.session.tools).toEqual([
      { type: 'web_search' },
      { type: 'x_search' },
      { type: 'file_search' }
    ]);
    expect(event.session.tool_choice).toBe('auto');
  });

  test('buildSessionUpdateEvent combines all extended settings correctly', () => {
    const tools: UnifiedTool[] = [
      { name: 'test.echo', description: 'Echo', parametersJsonSchema: { type: 'object', properties: {} } }
    ];

    const { event } = buildSessionUpdateEvent({
      spec: {
        provider: 'grok',
        systemPrompt: 'Be helpful',
        turnDetection: { mode: 'server_vad' },
        settings: {
          voice: 'sage',
          temperature: 0.9,
          vadThreshold: 0.55,
          vad_prefix_padding_ms: 200,
          vad_silence_duration_ms: 350,
          enableWebSearch: true,
          enableXSearch: true
        } as any
      },
      defaultVoice: 'ara',
      tools
    });

    expect(event.session.voice).toBe('sage');
    expect(event.session.temperature).toBe(0.9);
    expect(event.session.turn_detection.type).toBe('server_vad');
    expect(event.session.turn_detection.threshold).toBe(0.55);
    expect(event.session.turn_detection.prefix_padding_ms).toBe(200);
    expect(event.session.turn_detection.silence_duration_ms).toBe(350);
    expect(event.session.tools).toHaveLength(3);
    expect(event.session.tools[0].name).toBe('test_echo');
    expect(event.session.tools[1]).toEqual({ type: 'web_search' });
    expect(event.session.tools[2]).toEqual({ type: 'x_search' });
  });
});
