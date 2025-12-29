import { parseRealtimeSessionSettings } from '@/kernel/index.ts';

describe('kernel/realtime-session-settings', () => {
  test('returns empty when settings is not a plain object', () => {
    const defs = { voice: { type: 'string' } } as const;

    for (const value of [undefined, null, 0, true, 'x', []]) {
      expect(parseRealtimeSessionSettings(value as any, defs)).toEqual({ values: {}, unknownKeys: [], invalidKeys: [] });
    }
  });

  test('parses known settings, supports aliases, ignores blanks, and reports unknown/invalid keys', () => {
    const { values, unknownKeys, invalidKeys } = parseRealtimeSessionSettings(
      {
        speaker: '  Alice  ',
        temperature: '0.7',
        temperature2: undefined,
        rate: '',
        pitch: Infinity,
        tempo: 'nope',
        maxTokens: 3.9,
        maxOutputTokens: 0,
        quota: null,
        count: '',
        persona: '',
        persona2: undefined,
        personaNull: null,
        unknownKey: 'x'
      },
      {
        voice: { type: 'string', aliases: ['speaker'] },
        temperature: { type: 'number' },
        temperature2: { type: 'number' },
        rate: { type: 'number' },
        pitch: { type: 'number' },
        tempo: { type: 'number' },
        maxOutputTokens: { type: 'int', aliases: ['maxTokens'] },
        quota: { type: 'int' },
        count: { type: 'int' },
        persona: { type: 'string' },
        persona2: { type: 'string' },
        personaNull: { type: 'string' }
      }
    );

    expect(values).toMatchObject({ voice: 'Alice', temperature: 0.7, maxOutputTokens: 3 });
    expect(values).not.toHaveProperty('rate');
    expect(values).not.toHaveProperty('pitch');
    expect(values).not.toHaveProperty('tempo');
    expect(values).not.toHaveProperty('quota');
    expect(values).not.toHaveProperty('count');
    expect(values).not.toHaveProperty('persona');
    expect(values).not.toHaveProperty('persona2');
    expect(values).not.toHaveProperty('personaNull');

    expect(unknownKeys).toEqual(['unknownKey']);
    expect(invalidKeys.sort()).toEqual(['maxOutputTokens', 'persona', 'pitch', 'tempo'].sort());
  });

  test('treats definition mismatches as unknown keys', () => {
    const defs: any = { mut: { type: 'string' } };
    const settings = {} as any;
    Object.defineProperty(settings, 'mut', {
      enumerable: true,
      get() {
        delete defs.mut;
        return 'x';
      }
    });

    const { values, unknownKeys, invalidKeys } = parseRealtimeSessionSettings(settings, defs);
    expect(values).toEqual({});
    expect(unknownKeys).toEqual(['mut']);
    expect(invalidKeys).toEqual([]);
  });
});

