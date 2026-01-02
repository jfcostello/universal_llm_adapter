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

  test('parses boolean settings with various truthy/falsy string values', () => {
    const defs = {
      enabled: { type: 'boolean' as const },
      active: { type: 'boolean' as const, aliases: ['isActive'] },
      flag: { type: 'boolean' as const }
    };

    // Test truthy string values
    for (const truthy of ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'y', 'Y', 'on', 'ON']) {
      const { values } = parseRealtimeSessionSettings({ enabled: truthy }, defs);
      expect(values.enabled).toBe(true);
    }

    // Test falsy string values
    for (const falsy of ['false', 'FALSE', 'False', '0', 'no', 'NO', 'n', 'N', 'off', 'OFF']) {
      const { values } = parseRealtimeSessionSettings({ enabled: falsy }, defs);
      expect(values.enabled).toBe(false);
    }

    // Test actual booleans
    expect(parseRealtimeSessionSettings({ enabled: true }, defs).values.enabled).toBe(true);
    expect(parseRealtimeSessionSettings({ enabled: false }, defs).values.enabled).toBe(false);

    // Test numbers (0 = false, non-zero = true)
    expect(parseRealtimeSessionSettings({ enabled: 0 }, defs).values.enabled).toBe(false);
    expect(parseRealtimeSessionSettings({ enabled: 1 }, defs).values.enabled).toBe(true);
    expect(parseRealtimeSessionSettings({ enabled: -1 }, defs).values.enabled).toBe(true);
    expect(parseRealtimeSessionSettings({ enabled: 42 }, defs).values.enabled).toBe(true);

    // Test aliases
    expect(parseRealtimeSessionSettings({ isActive: 'yes' }, defs).values.active).toBe(true);
  });

  test('reports invalid boolean values and ignores blank values', () => {
    const defs = {
      enabled: { type: 'boolean' as const },
      active: { type: 'boolean' as const }
    };

    // Invalid string values
    const { values: v1, invalidKeys: i1 } = parseRealtimeSessionSettings({ enabled: 'maybe' }, defs);
    expect(v1.enabled).toBeUndefined();
    expect(i1).toEqual(['enabled']);

    const { values: v2, invalidKeys: i2 } = parseRealtimeSessionSettings({ enabled: 'nope' }, defs);
    expect(v2.enabled).toBeUndefined();
    expect(i2).toEqual(['enabled']);

    // Blank values are silently ignored
    expect(parseRealtimeSessionSettings({ enabled: '' }, defs).invalidKeys).toEqual([]);
    expect(parseRealtimeSessionSettings({ enabled: null }, defs).invalidKeys).toEqual([]);
    expect(parseRealtimeSessionSettings({ enabled: undefined }, defs).invalidKeys).toEqual([]);

    // Whitespace-only string is invalid
    const { values: v3, invalidKeys: i3 } = parseRealtimeSessionSettings({ enabled: '   ' }, defs);
    expect(v3.enabled).toBeUndefined();
    expect(i3).toEqual(['enabled']);

    // Objects/arrays are invalid for boolean type
    const { values: v4, invalidKeys: i4 } = parseRealtimeSessionSettings({ enabled: { key: 'value' } }, defs);
    expect(v4.enabled).toBeUndefined();
    expect(i4).toEqual(['enabled']);

    const { values: v5, invalidKeys: i5 } = parseRealtimeSessionSettings({ enabled: ['array'] }, defs);
    expect(v5.enabled).toBeUndefined();
    expect(i5).toEqual(['enabled']);
  });
});

