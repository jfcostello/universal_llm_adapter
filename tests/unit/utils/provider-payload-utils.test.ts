import { applyProviderPayloadExtensions } from '@/utils/provider-payload-utils.ts';
import { ProviderPayloadError } from '@/core/errors.ts';

const baseProvider: any = {
  id: 'provider-x',
  payloadExtensions: [
    {
      name: 'object-extension',
      settingsKey: 'objectOption',
      targetPath: ['extra', 'object'],
      valueType: 'object',
      required: true,
      default: { enabled: true, threshold: 0.5 }
    },
    {
      name: 'array-extension',
      settingsKey: 'arrayOption',
      targetPath: ['extra', 'list'],
      valueType: 'array',
      default: [1, 2, 3]
    },
    {
      name: 'replace-extension',
      settingsKey: 'replaceOption',
      targetPath: ['extra', 'replace'],
      valueType: 'string',
      mergeStrategy: 'replace'
    }
  ]
};

describe('utils/provider-payload-utils', () => {
  test('applies defaults, merges objects, and returns remaining extras', () => {
    const payload = { extra: { object: { enabled: false } } };
    const [result, remaining] = applyProviderPayloadExtensions(baseProvider, payload, {
      objectOption: { threshold: 0.9 },
      arrayOption: [4],
      replaceOption: 'value',
      passthrough: 'keep-me'
    });

    expect(result.extra.object).toEqual({ enabled: true, threshold: 0.9 });
    expect(result.extra.list).toEqual([4]);
    expect(result.extra.replace).toBe('value');
    expect(remaining).toEqual({ passthrough: 'keep-me' });
  });

  test('throws when required extension missing and no default', () => {
    const provider = {
      id: 'provider-y',
      payloadExtensions: [
        {
          name: 'required',
          settingsKey: 'mustProvide',
          targetPath: ['extra', 'required'],
          valueType: 'string',
          required: true
        }
      ]
    };

    expect(() => applyProviderPayloadExtensions(provider as any, {}, {})).toThrow(ProviderPayloadError);
  });

  test('validates value types', () => {
    const provider = {
      id: 'provider-z',
      payloadExtensions: [
        {
          name: 'expect-number',
          settingsKey: 'value',
          targetPath: ['extra', 'number'],
          valueType: 'number'
        },
        {
          name: 'expect-boolean',
          settingsKey: 'flag',
          targetPath: ['extra', 'flag'],
          valueType: 'boolean'
        },
        {
          name: 'expect-object',
          settingsKey: 'object',
          targetPath: ['extra', 'object'],
          valueType: 'object'
        },
        {
          name: 'expect-array',
          settingsKey: 'array',
          targetPath: ['extra', 'array'],
          valueType: 'array'
        },
        {
          name: 'expect-string',
          settingsKey: 'text',
          targetPath: ['extra', 'text'],
          valueType: 'string'
        }
      ]
    };

    expect(() => applyProviderPayloadExtensions(provider as any, {}, { value: 'nope' })).toThrow(
      ProviderPayloadError
    );
    expect(() => applyProviderPayloadExtensions(provider as any, {}, { flag: 'true' })).toThrow(
      ProviderPayloadError
    );
    expect(() => applyProviderPayloadExtensions(provider as any, {}, { object: 'nope' })).toThrow(
      ProviderPayloadError
    );
    expect(() => applyProviderPayloadExtensions(provider as any, {}, { array: 'not-array' })).toThrow(
      ProviderPayloadError
    );
    expect(() => applyProviderPayloadExtensions(provider as any, {}, { text: 123 })).toThrow(
      ProviderPayloadError
    );
  });

  test('deep merges defaults, handles null defaults, and preserves remaining extras', () => {
    const provider = {
      id: 'provider-nested',
      payloadExtensions: [
        {
          name: 'nested-object',
          settingsKey: 'nested',
          targetPath: ['extra', 'nested'],
          valueType: 'object',
          default: {
            a: { base: 1 },
            flag: false
          }
        },
        {
          name: 'optional-null',
          settingsKey: 'optional',
          targetPath: ['extra', 'optional'],
          valueType: 'string',
          default: null,
          required: false
        }
      ]
    };

    const payload = { extra: { nested: { override: true } } };
    const [result, remaining] = applyProviderPayloadExtensions(provider as any, payload, {
      nested: { a: { added: 2 } },
      passthrough: 'keep'
    });

    expect(result.extra.nested).toEqual({
      override: true,
      a: { base: 1, added: 2 },
      flag: false
    });
    expect(result.extra.optional).toBeUndefined();
    expect(remaining).toEqual({ passthrough: 'keep' });
  });

  test('throws when target path empty', () => {
    const provider = {
      id: 'provider-empty',
      payloadExtensions: [
        {
          name: 'bad-target',
          settingsKey: 'missing',
          targetPath: [],
          valueType: 'string',
          default: 'x'
        }
      ]
    };

    expect(() => applyProviderPayloadExtensions(provider as any, {}, {})).toThrow(
      'Target path for provider payload extension cannot be empty'
    );
  });

  test('creates intermediate containers and overwrites scalar fields', () => {
    const provider = {
      id: 'provider-overwrite',
      payloadExtensions: [
        {
          name: 'create-nested',
          settingsKey: 'nestedText',
          targetPath: ['newContainer', 'label'],
          valueType: 'string'
        },
        {
          name: 'overwrite-existing',
          settingsKey: 'existingText',
          targetPath: ['extra', 'label'],
          valueType: 'string'
        }
      ]
    };

    const payload = { extra: { label: 'old' } };
    const [result] = applyProviderPayloadExtensions(provider as any, payload, {
      nestedText: 'created',
      existingText: 'new'
    });

    expect(result.newContainer.label).toBe('created');
    expect(result.extra.label).toBe('new');
  });

  test('throws when required extension default is null', () => {
    const provider = {
      id: 'provider-null-required',
      payloadExtensions: [
        {
          name: 'null-default-required',
          settingsKey: 'missing',
          targetPath: ['extra', 'required'],
          valueType: 'string',
          default: null,
          required: true
        }
      ]
    };

    expect(() => applyProviderPayloadExtensions(provider as any, {}, {})).toThrow(ProviderPayloadError);
  });

  test('valueType any bypasses validation and leaves extra settings intact', () => {
    const provider = {
      id: 'provider-any',
      payloadExtensions: [
        {
          name: 'any-extension',
          settingsKey: 'anyOption',
          targetPath: ['extra', 'any'],
          valueType: 'any'
        }
      ]
    };

    const [result, remaining] = applyProviderPayloadExtensions(provider as any, {}, {
      anyOption: { arbitrary: true },
      untouched: 'value'
    });

    expect(result.extra.any).toEqual({ arbitrary: true });
    expect(remaining).toEqual({ untouched: 'value' });
  });

  test('applyProviderPayloadExtensions does not mutate original payload', () => {
    const payload = { extra: { base: true } };
    const clone = JSON.parse(JSON.stringify(payload));

    applyProviderPayloadExtensions(baseProvider, payload, {
      objectOption: { threshold: 1 },
      arrayOption: [9]
    });

    expect(payload).toEqual(clone);
  });

  test('returns payload unchanged when provider has no extensions', () => {
    const payload = { data: true };
    const [result, remaining] = applyProviderPayloadExtensions({ id: 'plain' } as any, payload);
    expect(result).toEqual(payload);
    expect(remaining).toEqual({});
  });
});
