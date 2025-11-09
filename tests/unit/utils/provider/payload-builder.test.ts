import { describe, expect, jest, test } from '@jest/globals';
import { buildFinalPayload } from '@/utils/provider/payload-builder.ts';
import {
  ICompatModule,
  LLMCallSettings,
  Message,
  ProviderManifest,
  ToolChoice,
  UnifiedTool
} from '@/core/types.ts';

function createCompat(): ICompatModule {
  return {
    buildPayload: (model: string, _settings: LLMCallSettings, messages: Message[], tools: UnifiedTool[], toolChoice?: ToolChoice) => ({
      body: {
        model,
        messagesLength: messages.length,
        toolCount: tools.length,
        toolChoice: toolChoice ?? 'auto'
      }
    }),
    parseResponse: jest.fn(),
    parseStreamChunk: jest.fn(() => ({})),
    getStreamingFlags: jest.fn(() => ({ stream: true })),
    serializeTools: jest.fn(),
    serializeToolChoice: jest.fn(),
    applyProviderExtensions: (payload: any, extras: Record<string, any>) => {
      if ('compat-mode' in extras) {
        payload.body.compatMode = extras['compat-mode'];
        extras['compat-mode'] = undefined;
      }
      return payload;
    }
  };
}

describe('utils/provider/payload-builder', () => {
  const provider: ProviderManifest = {
    id: 'test-provider',
    compat: 'test-compat',
    endpoint: {
      urlTemplate: 'https://example.com/{model}',
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    },
    payloadExtensions: [
      {
        name: 'response format',
        settingsKey: 'response_format',
        targetPath: ['body', 'metadata', 'response_format'],
        valueType: 'string'
      }
    ]
  };

  const baseMessages: Message[] = [
    { role: 'user' as const, content: [{ type: 'text', text: 'Hello' }] }
  ];

  test('buildFinalPayload merges manifest and compat extras while tracking leftovers', () => {
    const compat = createCompat();

    const { payload, unconsumedExtras } = buildFinalPayload({
      provider,
      compat,
      model: 'test-model',
      settings: {} as LLMCallSettings,
      messages: baseMessages,
      tools: [],
      toolChoice: 'auto',
      providerExtras: {
        response_format: 'json_schema',
        'compat-mode': 'lite',
        'unused-field': 42
      }
    });

    expect(payload.body.metadata).toEqual({ response_format: 'json_schema' });
    expect(payload.body.compatMode).toBe('lite');
    expect(unconsumedExtras).toEqual({ 'unused-field': 42 });
  });

  test('buildFinalPayload appends streaming flags when streaming=true', () => {
    const compat = createCompat();

    const { payload, unconsumedExtras } = buildFinalPayload({
      provider,
      compat,
      model: 'stream-model',
      settings: {} as LLMCallSettings,
      messages: baseMessages,
      tools: [],
      providerExtras: {},
      streaming: true
    });

    expect(payload).toMatchObject({
      body: expect.any(Object),
      stream: true
    });
    expect(unconsumedExtras).toEqual({});
    expect(compat.getStreamingFlags).toHaveBeenCalled();
  });

  test('buildFinalPayload defaults providerExtras to empty object', () => {
    const compat = createCompat();

    const { payload, unconsumedExtras } = buildFinalPayload({
      provider,
      compat,
      model: 'no-extras',
      settings: {} as LLMCallSettings,
      messages: baseMessages,
      tools: []
    });

    expect(payload.body.toolCount).toBe(0);
    expect(unconsumedExtras).toEqual({});
  });

  test('buildFinalPayload works when compat applyProviderExtensions is undefined', () => {
    const compatWithoutApply: ICompatModule = {
      buildPayload: (model: string) => ({ body: { model } }),
      parseResponse: jest.fn(),
      parseStreamChunk: jest.fn(() => ({})),
      getStreamingFlags: jest.fn(() => ({})),
      serializeTools: jest.fn(),
      serializeToolChoice: jest.fn()
    };

    const { payload, unconsumedExtras } = buildFinalPayload({
      provider,
      compat: compatWithoutApply,
      model: 'simple-model',
      settings: {} as LLMCallSettings,
      messages: baseMessages,
      tools: [],
      providerExtras: { response_format: 'text', extra_field: true }
    });

    expect(payload.body).toEqual({ model: 'simple-model', metadata: { response_format: 'text' } });
    expect(unconsumedExtras).toEqual({ extra_field: true });
  });

  test('buildFinalPayload handles providers without payload extensions', () => {
    const compat = createCompat();
    const providerWithoutExtensions: ProviderManifest = {
      ...provider,
      payloadExtensions: undefined
    };

    const { payload, unconsumedExtras } = buildFinalPayload({
      provider: providerWithoutExtensions,
      compat,
      model: 'no-exts',
      settings: {} as LLMCallSettings,
      messages: baseMessages,
      tools: [],
      providerExtras: { 'compat-mode': 'standard', leftover: 'value' }
    });

    expect(payload.body.compatMode).toBe('standard');
    expect(unconsumedExtras).toEqual({ leftover: 'value' });
  });
});
