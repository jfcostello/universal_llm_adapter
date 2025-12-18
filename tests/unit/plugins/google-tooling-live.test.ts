import { serializeToolsForLiveSDK } from '@/plugins/modules/google-tooling/index.ts';

describe('plugins/modules/google-tooling — live tool serialization', () => {
  test('serializeToolsForLiveSDK returns undefined for missing/empty tools', () => {
    expect(serializeToolsForLiveSDK(undefined as any)).toBeUndefined();
    expect(serializeToolsForLiveSDK([] as any)).toBeUndefined();
  });

  test('serializeToolsForLiveSDK emits functionDeclarations with parametersJsonSchema', () => {
    const out = serializeToolsForLiveSDK([
      {
        name: 'test.echo',
        description: 'Echo',
        parametersJsonSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message']
        }
      }
    ]);

    expect(out).toEqual([
      {
        functionDeclarations: [
          {
            name: 'test_echo',
            description: 'Echo',
            parametersJsonSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message']
            }
          }
        ]
      }
    ]);
  });

  test('serializeToolsForLiveSDK defaults description and parametersJsonSchema', () => {
    const out = serializeToolsForLiveSDK([{ name: 'custom/tool' }]);

    expect(out?.[0]?.functionDeclarations?.[0]).toEqual({
      name: 'custom_tool',
      description: '',
      parametersJsonSchema: { type: 'object', properties: {} }
    });
  });
});

