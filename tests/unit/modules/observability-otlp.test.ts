import { describe, expect, jest, test } from '@jest/globals';

describe('modules/observability OTLP helpers', () => {
  test('deriveOtlpTraceIdHex returns a valid 16-byte trace id (32 hex chars)', async () => {
    const { deriveOtlpTraceIdHex } = await import('@/modules/observability/internal/otlp/ids.ts');
    const id = deriveOtlpTraceIdHex('hello-world');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toBe('0'.repeat(32));
  });

  test('deriveOtlpTraceIdHex is stable and preserves valid hex input', async () => {
    const { deriveOtlpTraceIdHex } = await import('@/modules/observability/internal/otlp/ids.ts');
    const input = '0123456789abcdef0123456789abcdef';
    expect(deriveOtlpTraceIdHex(input)).toBe(input);
    expect(deriveOtlpTraceIdHex('same-seed')).toBe(deriveOtlpTraceIdHex('same-seed'));
  });

  test('deriveOtlpTraceIdHex normalizes casing/whitespace and rejects all-zero traceIds', async () => {
    const { deriveOtlpTraceIdHex } = await import('@/modules/observability/internal/otlp/ids.ts');

    const normalized = deriveOtlpTraceIdHex('  0123456789ABCDEF0123456789ABCDEF  ');
    expect(normalized).toBe('0123456789abcdef0123456789abcdef');

    const hashed = deriveOtlpTraceIdHex('0'.repeat(32));
    expect(hashed).toMatch(/^[0-9a-f]{32}$/);
    expect(hashed).not.toBe('0'.repeat(32));
  });

  test('deriveOtlpSpanIdHex returns a valid 8-byte span id (16 hex chars)', async () => {
    const { deriveOtlpSpanIdHex } = await import('@/modules/observability/internal/otlp/ids.ts');
    const id = deriveOtlpSpanIdHex('gen-123');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toBe('0'.repeat(16));
  });

  test('deriveOtlp* patches all-zero digests (defensive correctness)', async () => {
    jest.resetModules();

    const originalCrypto = await import('crypto');
    const cryptoMock: any = {
      __esModule: true,
      ...originalCrypto,
      createHash: () => {
        const hash: any = {
          update: () => hash,
          digest: () => Buffer.alloc(64, 0)
        };
        return hash;
      }
    };
    cryptoMock.default = cryptoMock;

    (jest as any).unstable_mockModule('crypto', () => cryptoMock);

    const { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } = await import(
      '@/modules/observability/internal/otlp/ids.ts'
    );

    expect(deriveOtlpTraceIdHex('seed')).toBe(`${'0'.repeat(30)}01`);
    expect(deriveOtlpSpanIdHex('seed')).toBe(`${'0'.repeat(14)}01`);

    jest.resetModules();
  });

  test('isoToOtlpHrTime converts ISO timestamps to hrtime', async () => {
    const { isoToOtlpHrTime } = await import('@/modules/observability/internal/otlp/time.ts');
    expect(isoToOtlpHrTime('1970-01-01T00:00:00.000Z')).toEqual([0, 0]);
    expect(isoToOtlpHrTime('1970-01-01T00:00:01.000Z')).toEqual([1, 0]);
  });

  test('isoToOtlpHrTime returns [0,0] for invalid timestamps', async () => {
    const { isoToOtlpHrTime } = await import('@/modules/observability/internal/otlp/time.ts');
    expect(isoToOtlpHrTime('not-a-date')).toEqual([0, 0]);
  });

  test('createReadableSpanFromSpec fills required OTLP fields and computes duration', async () => {
    const { createReadableSpanFromSpec } = await import('@/modules/observability/internal/otlp/spans.ts');

    const span = createReadableSpanFromSpec({
      traceIdHex: '0123456789abcdef0123456789abcdef',
      spanIdHex: '0123456789abcdef',
      parentSpanIdHex: 'ffffffffffffffff',
      name: 'test',
      startTimeIso: '1970-01-01T00:00:01.900Z',
      endTimeIso: '1970-01-01T00:00:02.100Z',
      status: { code: 'ERROR', message: 'boom' },
      attributes: { 'a': 'b' }
    });

    expect(span.name).toBe('test');
    expect(span.parentSpanId).toBe('ffffffffffffffff');
    expect(span.status.code).toBe(2);
    expect(span.status.message).toBe('boom');
    expect(span.duration).toEqual([0, 200000000]);
    expect((span.resource as any).attributes['service.name']).toBe('universal-llm-adapter');
    expect(typeof (span.resource as any).attributes['service.version']).toBe('string');
    expect((span.resource as any).attributes['service.version']).not.toBe('');

    const unset = createReadableSpanFromSpec({
      traceIdHex: '0123456789abcdef0123456789abcdef',
      spanIdHex: '0123456789abcdef',
      name: 'unset',
      startTimeIso: '1970-01-01T00:00:00.000Z',
      endTimeIso: '1970-01-01T00:00:00.000Z'
    });
    expect(unset.status.code).toBe(0);
  });

  test('service.version prefers LLM_ADAPTER_VERSION when set', async () => {
    jest.resetModules();

    const originalAdapterVersion = process.env.LLM_ADAPTER_VERSION;
    const originalNpmVersion = process.env.npm_package_version;
    process.env.LLM_ADAPTER_VERSION = '  9.9.9  ';
    process.env.npm_package_version = '8.8.8';

    const { createReadableSpanFromSpec } = await import('@/modules/observability/internal/otlp/spans.ts');
    const span = createReadableSpanFromSpec({
      traceIdHex: '0123456789abcdef0123456789abcdef',
      spanIdHex: '0123456789abcdef',
      name: 'test',
      startTimeIso: '1970-01-01T00:00:00.000Z',
      endTimeIso: '1970-01-01T00:00:00.000Z'
    });

    expect((span.resource as any).attributes['service.version']).toBe('9.9.9');

    if (originalAdapterVersion !== undefined) process.env.LLM_ADAPTER_VERSION = originalAdapterVersion;
    else delete process.env.LLM_ADAPTER_VERSION;
    if (originalNpmVersion !== undefined) process.env.npm_package_version = originalNpmVersion;
    else delete process.env.npm_package_version;

    jest.resetModules();
  });

  test('service.version falls back to package.json when env is unset/blank', async () => {
    jest.resetModules();

    const originalAdapterVersion = process.env.LLM_ADAPTER_VERSION;
    const originalNpmVersion = process.env.npm_package_version;
    process.env.LLM_ADAPTER_VERSION = '   ';
    delete process.env.npm_package_version;

    const { createReadableSpanFromSpec } = await import('@/modules/observability/internal/otlp/spans.ts');
    const span = createReadableSpanFromSpec({
      traceIdHex: '0123456789abcdef0123456789abcdef',
      spanIdHex: '0123456789abcdef',
      name: 'test',
      startTimeIso: '1970-01-01T00:00:00.000Z',
      endTimeIso: '1970-01-01T00:00:00.000Z'
    });

    const { readFileSync } = await import('fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect((span.resource as any).attributes['service.version']).toBe(pkg.version);

    if (originalAdapterVersion !== undefined) process.env.LLM_ADAPTER_VERSION = originalAdapterVersion;
    else delete process.env.LLM_ADAPTER_VERSION;
    if (originalNpmVersion !== undefined) process.env.npm_package_version = originalNpmVersion;
    else delete process.env.npm_package_version;

    jest.resetModules();
  });

  test('service.version returns unknown when package.json version is invalid', async () => {
    jest.resetModules();

    const originalAdapterVersion = process.env.LLM_ADAPTER_VERSION;
    const originalNpmVersion = process.env.npm_package_version;
    delete process.env.LLM_ADAPTER_VERSION;
    delete process.env.npm_package_version;

    const originalFs = await import('fs');
    let callCount = 0;
    const fsMock: any = {
      __esModule: true,
      ...originalFs,
      readFileSync: () => {
        callCount++;
        if (callCount === 1) return JSON.stringify({ version: '   ' });
        return JSON.stringify({ version: 123 });
      }
    };
    fsMock.default = fsMock;

    (jest as any).unstable_mockModule('fs', () => fsMock);

    const { createReadableSpanFromSpec } = await import('@/modules/observability/internal/otlp/spans.ts');
    const span = createReadableSpanFromSpec({
      traceIdHex: '0123456789abcdef0123456789abcdef',
      spanIdHex: '0123456789abcdef',
      name: 'test',
      startTimeIso: '1970-01-01T00:00:00.000Z',
      endTimeIso: '1970-01-01T00:00:00.000Z'
    });

    expect((span.resource as any).attributes['service.version']).toBe('unknown');

    if (originalAdapterVersion !== undefined) process.env.LLM_ADAPTER_VERSION = originalAdapterVersion;
    else delete process.env.LLM_ADAPTER_VERSION;
    if (originalNpmVersion !== undefined) process.env.npm_package_version = originalNpmVersion;
    else delete process.env.npm_package_version;

    jest.resetModules();
  });

  test('service.version returns unknown when package.json cannot be read', async () => {
    jest.resetModules();

    const originalAdapterVersion = process.env.LLM_ADAPTER_VERSION;
    const originalNpmVersion = process.env.npm_package_version;
    delete process.env.LLM_ADAPTER_VERSION;
    delete process.env.npm_package_version;

    const originalFs = await import('fs');
    const fsMock: any = {
      __esModule: true,
      ...originalFs,
      readFileSync: () => {
        throw new Error('boom');
      }
    };
    fsMock.default = fsMock;

    (jest as any).unstable_mockModule('fs', () => fsMock);

    const { createReadableSpanFromSpec } = await import('@/modules/observability/internal/otlp/spans.ts');
    const span = createReadableSpanFromSpec({
      traceIdHex: '0123456789abcdef0123456789abcdef',
      spanIdHex: '0123456789abcdef',
      name: 'test',
      startTimeIso: '1970-01-01T00:00:00.000Z',
      endTimeIso: '1970-01-01T00:00:00.000Z'
    });

    expect((span.resource as any).attributes['service.version']).toBe('unknown');

    if (originalAdapterVersion !== undefined) process.env.LLM_ADAPTER_VERSION = originalAdapterVersion;
    else delete process.env.LLM_ADAPTER_VERSION;
    if (originalNpmVersion !== undefined) process.env.npm_package_version = originalNpmVersion;
    else delete process.env.npm_package_version;

    jest.resetModules();
  });

  test('createReadableSpanFromSpec clamps negative durations to zero', async () => {
    const { createReadableSpanFromSpec } = await import('@/modules/observability/internal/otlp/spans.ts');

    const span = createReadableSpanFromSpec({
      traceIdHex: '0123456789abcdef0123456789abcdef',
      spanIdHex: '0123456789abcdef',
      name: 'test',
      startTimeIso: '1970-01-01T00:00:02.000Z',
      endTimeIso: '1970-01-01T00:00:01.000Z',
      status: { code: 'OK' }
    });

    expect(span.status.code).toBe(1);
    expect(span.duration).toEqual([0, 0]);
  });

  test('encodeOtlpTraceRequest returns non-empty protobuf bytes', async () => {
    const { encodeOtlpTraceRequest } = await import('@/modules/observability/internal/otlp/encode.ts');

    const bytes = encodeOtlpTraceRequest([
      {
        traceIdHex: '0123456789abcdef0123456789abcdef',
        spanIdHex: '0123456789abcdef',
        name: 'llm.generation',
        startTimeIso: '2024-01-01T00:00:00.000Z',
        endTimeIso: '2024-01-01T00:00:01.000Z',
        status: { code: 'OK' },
        attributes: {
          'langfuse.observation.model.name': 'model-a',
          'langfuse.observation.input': '{"messages":[\"hi\"]}',
          'langfuse.observation.output': '{"content":[\"ok\"]}'
        }
      }
    ]);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
