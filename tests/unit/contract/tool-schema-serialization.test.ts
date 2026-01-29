import AnthropicCompat from '@/plugins/compat/anthropic/index.ts';
import GoogleCompat from '@/plugins/compat/google/index.ts';
import OpenAICompat from '@/plugins/compat/openai/index.ts';
import OpenAIAssistantsCompat from '@/plugins/compat/openai-assistants/index.ts';
import OpenAIResponsesCompat from '@/plugins/compat/openai-responses/index.ts';

import { buildGeminiSetupMessage } from '@/plugins/realtime-compat/gemini/internal/commands.ts';
import { buildSessionUpdateEvent as buildGrokSessionUpdateEvent } from '@/plugins/realtime-compat/grok/internal/commands.ts';
import { buildSessionUpdateEvent as buildOpenAISessionUpdateEvent } from '@/plugins/realtime-compat/openai/internal/commands.ts';
import { serializeTools as serializeVapiTools } from '@/plugins/realtime-compat/vapi/internal/session/internal/tools.ts';

describe('contract: tool schemas never serialize adapter-side routing metadata', () => {
  const TOOL_ID_SENTINEL = 'contract-tool-id-sentinel';
  const ROUTE_ID_SENTINEL = 'contract-route-id-sentinel';

  const toolWithRouting: any = {
    name: 'test.echo',
    description: 'Echo',
    parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } } },
    id: TOOL_ID_SENTINEL,
    processRouteId: ROUTE_ID_SENTINEL
  };

  function expectNoSentinels(value: unknown): void {
    const serialized = JSON.stringify(value) ?? '';
    expect(serialized).not.toContain(TOOL_ID_SENTINEL);
    expect(serialized).not.toContain(ROUTE_ID_SENTINEL);
  }

  describe('LLM compats', () => {
    test.each([
      ['anthropic', AnthropicCompat],
      ['google', GoogleCompat],
      ['openai', OpenAICompat],
      ['openai-assistants', OpenAIAssistantsCompat],
      ['openai-responses', OpenAIResponsesCompat]
    ])('%s: does not leak routing fields in serialized tools', (_name, CompatClass: any) => {
      const compat = new CompatClass();
      expectNoSentinels(compat.serializeTools([toolWithRouting]));
    });
  });

  describe('realtime compats', () => {
    test('openai: session.update tools omit routing fields', () => {
      const { event } = buildOpenAISessionUpdateEvent({
        spec: { provider: 'openai', model: 'm' },
        tools: [toolWithRouting]
      });
      expectNoSentinels(event.session.tools);
    });

    test('grok: session.update tools omit routing fields', () => {
      const { event } = buildGrokSessionUpdateEvent({
        spec: { provider: 'grok' },
        defaultVoice: 'voice',
        tools: [toolWithRouting]
      });
      expectNoSentinels(event.session.tools);
    });

    test('gemini: setup tools omit routing fields', () => {
      const { message } = buildGeminiSetupMessage({
        model: 'm',
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'manual_commit' } },
        tools: [toolWithRouting]
      });
      expectNoSentinels(message.setup.tools);
    });

    test('vapi: model tools omit routing fields', () => {
      const { toolsForModel } = serializeVapiTools([toolWithRouting], undefined);
      expectNoSentinels(toolsForModel);
    });
  });
});
