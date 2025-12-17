import type { UnifiedTool } from '@/modules/kernel/index.ts';
import {
  buildGeminiActivityEndMessage,
  buildGeminiClientContentMessage,
  buildGeminiCommitTextTurnMessage,
  buildGeminiInterruptMessage,
  buildGeminiRealtimeAudioMessage,
  buildGeminiSendTextMessage,
  buildGeminiSetupMessage,
  buildGeminiToolResponseMessage
} from '@/plugins/realtime-compat/gemini/internal/commands.ts';

describe('realtime-compat/gemini — commands', () => {
  test('buildGeminiSetupMessage defaults audio to pcm16@24k mono and disables automatic activity detection for manual_commit', () => {
    const { message, audio } = buildGeminiSetupMessage({
      model: 'm',
      spec: { provider: 'google', model: 'm', turnDetection: { mode: 'manual_commit' } }
    });

    expect(message.setup.model).toBe('models/m');
    expect(message.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(message.setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);
    expect(audio.input.format).toBe('pcm16');
    expect(audio.input.sampleRateHz).toBe(24000);
    expect(audio.input.channels).toBe(1);
  });

  test('buildGeminiSetupMessage includes system instruction, transcription, and tools', () => {
    const tools: UnifiedTool[] = [
      { name: 'test.echo', description: 'Echo', parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } } } }
    ];

    const { message } = buildGeminiSetupMessage({
      model: 'models/m',
      spec: {
        provider: 'google',
        model: 'm',
        systemPrompt: 'Hello',
        transcription: { enabled: true },
        turnDetection: { mode: 'manual_commit' }
      },
      tools
    });

    expect(message.setup.systemInstruction.parts[0].text).toBe('Hello');
    expect(message.setup.inputAudioTranscription).toEqual({});
    expect(message.setup.outputAudioTranscription).toEqual({});
    expect(message.setup.tools[0].functionDeclarations[0].name).toBe('test_echo');
  });

  test('buildGeminiSetupMessage accepts g711 formats for session I/O', () => {
    const { audio } = buildGeminiSetupMessage({
      model: 'm',
      spec: {
        provider: 'google',
        model: 'm',
        audio: {
          input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
          output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
        }
      }
    });

    expect(audio.input.format).toBe('g711_ulaw');
    expect(audio.output.sampleRateHz).toBe(8000);
  });

  test('buildGeminiSetupMessage rejects invalid audio configs', () => {
    expect(() =>
      buildGeminiSetupMessage({
        model: 'm',
        spec: {
          provider: 'google',
          model: 'm',
          audio: {
            input: 5 as any,
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          }
        } as any
      })
    ).toThrow('audio config must be an object');

    expect(() =>
      buildGeminiSetupMessage({
        model: 'm',
        spec: {
          provider: 'google',
          model: 'm',
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 2 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          }
        } as any
      })
    ).toThrow('channels=1');

    expect(() =>
      buildGeminiSetupMessage({
        model: 'm',
        spec: {
          provider: 'google',
          model: 'm',
          audio: {
            input: { format: 'g711_ulaw', sampleRateHz: 16000, channels: 1 },
            output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
          }
        } as any
      })
    ).toThrow('g711_ulaw requires sampleRateHz=8000');

    expect(() =>
      buildGeminiSetupMessage({
        model: 'm',
        spec: {
          provider: 'google',
          model: 'm',
          audio: {
            input: { format: 'mp3', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          }
        } as any
      })
    ).toThrow('Unsupported audio format');
  });

  test('buildGeminiClientContentMessage produces expected envelope', () => {
    const msg = buildGeminiClientContentMessage({ turns: [{ role: 'user', parts: [{ text: 'hi' }] }], turnComplete: false });
    expect(msg.clientContent.turnComplete).toBe(false);
    expect(msg.clientContent.turns[0].parts[0].text).toBe('hi');
  });

  test('buildGeminiClientContentMessage defaults turns to [] when input is not an array', () => {
    const msg = buildGeminiClientContentMessage({ turns: null as any, turnComplete: 'yes' as any });
    expect(msg.clientContent.turns).toEqual([]);
    expect(msg.clientContent.turnComplete).toBe(true);
  });

  test('buildGeminiSendTextMessage produces clientContent delta', () => {
    const msg = buildGeminiSendTextMessage({ text: 'hi', role: 'user' });
    expect(msg.clientContent.turnComplete).toBe(false);
    expect(msg.clientContent.turns[0].role).toBe('user');
  });

  test('buildGeminiSendTextMessage coerces missing text to empty string', () => {
    const msg = buildGeminiSendTextMessage({ text: undefined as any, role: 'user' });
    expect(msg.clientContent.turns[0].parts[0].text).toBe('');
  });

  test('commit/interrupt/activity/tool messages have expected shapes', () => {
    expect(buildGeminiCommitTextTurnMessage().clientContent.turnComplete).toBe(true);
    expect(buildGeminiInterruptMessage().clientContent.turnComplete).toBe(false);
    expect(buildGeminiActivityEndMessage().realtimeInput.activityEnd).toEqual({});

    const audioMsg = buildGeminiRealtimeAudioMessage({ audioBase64: 'AAA=', mimeType: 'audio/pcm;rate=16000', includeActivityStart: true });
    expect(audioMsg.realtimeInput.activityStart).toEqual({});
    expect(audioMsg.realtimeInput.audio.data).toBe('AAA=');

    const toolMsg = buildGeminiToolResponseMessage({ toolCallId: 'c1', name: 'test_echo', response: { output: 'ok' } });
    expect(toolMsg.toolResponse.functionResponses[0].id).toBe('c1');
  });

  test('buildGeminiRealtimeAudioMessage coerces missing audioBase64 to empty string', () => {
    const msg = buildGeminiRealtimeAudioMessage({ audioBase64: undefined as any, mimeType: 'audio/pcm;rate=16000' });
    expect(msg.realtimeInput.audio.data).toBe('');
  });

  test('buildGeminiSetupMessage preserves empty model strings', () => {
    const { message } = buildGeminiSetupMessage({
      model: '   ',
      spec: { provider: 'google', model: 'm' }
    });
    expect(message.setup.model).toBe('');
  });

  test('buildGeminiSetupMessage coerces undefined model to empty string', () => {
    const { message } = buildGeminiSetupMessage({
      model: undefined as any,
      spec: { provider: 'google', model: 'm' }
    });
    expect(message.setup.model).toBe('');
  });

  test('buildGeminiSetupMessage rejects pcm16 sampleRateHz when it is invalid', () => {
    expect(() =>
      buildGeminiSetupMessage({
        model: 'm',
        spec: {
          provider: 'google',
          model: 'm',
          audio: {
            input: { format: 'pcm16', sampleRateHz: 'no' as any, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          }
        } as any
      })
    ).toThrow('positive sampleRateHz');
  });
});
