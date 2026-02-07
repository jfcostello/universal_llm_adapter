import {
  assertValidSpec,
  assertValidVectorSpec,
  assertValidEmbeddingSpec,
  assertValidTelemetrySubmission,
  resolveAjvConstructor
} from '@/modules/server/internal/transport/spec-validator.ts';

describe('utils/server assertValidSpec', () => {
  test('accepts minimal valid spec', () => {
    expect(() =>
      assertValidSpec({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        llmPriority: [{ provider: 'p', model: 'm' }],
        settings: { temperature: 0 }
      } as any)
    ).not.toThrow();
  });

  test('rejects missing required fields', () => {
    expect(() => assertValidSpec({ messages: [] } as any)).toThrow(/validation/i);
  });

  test('rejects deprecated vectorContext field with migration details', () => {
    expect(() =>
      assertValidSpec({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        llmPriority: [{ provider: 'p', model: 'm' }],
        settings: {},
        vectorContext: { stores: ['memory'], mode: 'auto' }
      } as any)
    ).toThrow(/vectorContext/);
  });

  test('accepts toolChoice="required" string shorthand', () => {
    expect(() =>
      assertValidSpec({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        llmPriority: [{ provider: 'p', model: 'm' }],
        toolChoice: 'required',
        settings: { temperature: 0 }
      } as any)
    ).not.toThrow();
  });

  test('rejects vectorContexts entries missing required stores', () => {
    expect(() =>
      assertValidSpec({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        llmPriority: [{ provider: 'p', model: 'm' }],
        settings: {},
        vectorContexts: [{ mode: 'auto' }]
      } as any)
    ).toThrow(/validation/i);
  });

  test('rejects vectorContexts entries missing required mode', () => {
    expect(() =>
      assertValidSpec({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        llmPriority: [{ provider: 'p', model: 'm' }],
        settings: {},
        vectorContexts: [{ stores: ['memory'] }]
      } as any)
    ).toThrow(/validation/i);
  });

  test('accepts valid vectorContexts entries', () => {
    expect(() =>
      assertValidSpec({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        llmPriority: [{ provider: 'p', model: 'm' }],
        settings: {},
        vectorContexts: [{ stores: ['memory'], mode: 'auto' }]
      } as any)
    ).not.toThrow();
  });

  test('assertValidVectorSpec accepts minimal valid vector spec', () => {
    expect(() =>
      assertValidVectorSpec({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1], topK: 1 }
      } as any)
    ).not.toThrow();
  });

  test('assertValidVectorSpec rejects missing required fields', () => {
    expect(() => assertValidVectorSpec({ operation: 'query' } as any)).toThrow(/validation/i);
  });

  test('assertValidEmbeddingSpec accepts minimal valid embedding spec', () => {
    expect(() =>
      assertValidEmbeddingSpec({
        operation: 'embed',
        embeddingPriority: [{ provider: 'p' }],
        input: { texts: ['hello'] }
      } as any)
    ).not.toThrow();
  });

  test('assertValidEmbeddingSpec rejects missing required fields', () => {
    expect(() => assertValidEmbeddingSpec({} as any)).toThrow(/validation/i);
  });

  test('assertValidTelemetrySubmission accepts minimal signal payload', () => {
    expect(() =>
      assertValidTelemetrySubmission({
        type: 'signal',
        traceId: 'trace_1',
        level: 'error',
        message: 'boom'
      } as any)
    ).not.toThrow();
  });

  test('assertValidTelemetrySubmission rejects whitespace-only traceId', () => {
    expect(() =>
      assertValidTelemetrySubmission({
        type: 'signal',
        traceId: '   ',
        level: 'error',
        message: 'boom'
      } as any)
    ).toThrow(/telemetry/i);
  });

  test('assertValidTelemetrySubmission accepts minimal trace_update payload', () => {
    expect(() =>
      assertValidTelemetrySubmission({
        type: 'trace_update',
        traceId: 'trace_2'
      } as any)
    ).not.toThrow();
  });

  test('assertValidTelemetrySubmission rejects unknown telemetry type', () => {
    expect(() =>
      assertValidTelemetrySubmission({
        type: 'unknown',
        traceId: 'trace_3'
      } as any)
    ).toThrow(/telemetry/i);
  });

  test('assertValidTelemetrySubmission accepts observability overrides when allowlist is disabled', () => {
    expect(() =>
      assertValidTelemetrySubmission({
        type: 'signal',
        traceId: 'trace_4',
        level: 'error',
        message: 'boom',
        observability: {
          enabled: true,
          traceId: 'override-trace',
          customValue: 'permitted-when-policy-disabled'
        }
      } as any)
    ).not.toThrow();
  });

  test('assertValidTelemetrySubmission enforces observability override allowlist when configured', () => {
    expect(() =>
      assertValidTelemetrySubmission(
        {
          type: 'signal',
          traceId: 'trace_5',
          level: 'error',
          message: 'boom',
          observability: {
            enabled: true,
            traceId: 'override-trace'
          }
        } as any,
        { observabilityOverrideAllowlist: ['enabled', 'traceId'] }
      )
    ).not.toThrow();

    expect(() =>
      assertValidTelemetrySubmission(
        {
          type: 'signal',
          traceId: 'trace_6',
          level: 'error',
          message: 'boom',
          observability: {
            enabled: true,
            providerConfig: { token: 'x' }
          }
        } as any,
        { observabilityOverrideAllowlist: ['enabled', 'traceId'] }
      )
    ).toThrow(/telemetry/i);
  });

  test('assertValidTelemetrySubmission tolerates telemetry allowlist with non-string entries', () => {
    expect(() =>
      assertValidTelemetrySubmission(
        {
          type: 'signal',
          traceId: 'trace_7',
          level: 'error',
          message: 'boom',
          observability: { enabled: true }
        } as any,
        { observabilityOverrideAllowlist: ['enabled', '  ', 123 as any] }
      )
    ).not.toThrow();
  });

  test('assertValidTelemetrySubmission allows payloads without observability override when allowlist is enabled', () => {
    expect(() =>
      assertValidTelemetrySubmission(
        {
          type: 'trace_update',
          traceId: 'trace_8',
          name: 'trace-name'
        } as any,
        { observabilityOverrideAllowlist: ['enabled'] }
      )
    ).not.toThrow();
  });

  test('resolveAjvConstructor uses default when present', () => {
    const ctor = () => {};
    expect(resolveAjvConstructor({ default: ctor })).toBe(ctor);
  });

  test('resolveAjvConstructor falls back to module when no default', () => {
    const mod = () => {};
    expect(resolveAjvConstructor(mod)).toBe(mod);
  });
});
