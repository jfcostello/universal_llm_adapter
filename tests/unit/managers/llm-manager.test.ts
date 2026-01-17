import { jest } from '@jest/globals';
import { LLMManager } from '@/modules/llm/index.ts';
import { ProviderExecutionError } from '@/kernel/index.ts';
import { partitionSettings } from '@/modules/settings/index.ts';

const provider = {
  id: 'test-openai',
  compat: 'openai',
  endpoint: {
    urlTemplate: 'http://service/{model}',
    method: 'POST',
    headers: { Authorization: 'Bearer token' }
  },
  retryWords: ['limit'],
  payloadExtensions: [
    {
      name: 'routing',
      settingsKey: 'routing',
      targetPath: ['metadata', 'routing'],
      valueType: 'array'
    }
  ]
} as any;

function createCompat() {
  return {
    buildPayload: jest.fn(() => ({ metadata: {} })),
    parseResponse: jest.fn(() => ({ role: 'assistant', content: [] })),
    applyProviderExtensions: jest.fn((payload: any) => ({ ...payload, extended: true }))
  };
}

describe('managers/llm-manager', () => {
  test('logs unknown extras but ignores runtime keys', async () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({
        status: 200,
        data: { choices: [], usage: {} }
      })
    };
    (manager as any).httpClient = httpClient;

    const logger = {
      info: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    const partitioned = partitionSettings({
      temperature: 0.2,
      routing: ['fast'],
      toolCountdownEnabled: false,
      fakeField: 'value'
    });

    await manager.callProvider(
      provider,
      'model-x',
      partitioned.provider,
      [],
      [],
      undefined,
      partitioned.providerExtras,
      logger
    );

    const loggedFields = logger.info.mock.calls.map(call => call[1]?.field).filter(Boolean);
    expect(loggedFields).toContain('fakeField');
    expect(loggedFields).not.toContain('toolCountdownEnabled');
    expect(loggedFields).not.toContain('routing');

    const fakeFieldLog = logger.info.mock.calls.map(call => call[1]).find((data: any) => data?.field === 'fakeField');
    expect(fakeFieldLog?.value).toBe('***alue');
  });

  test('splits providerExtras between manifest and compat extensions', async () => {
    const compat = createCompat();
    compat.applyProviderExtensions = jest.fn((payload: any, extras: any) => ({
      ...payload,
      compatExtras: extras
    }));

    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({ status: 200, data: { choices: [], usage: {} } })
    };
    (manager as any).httpClient = httpClient;

    const logger = { info: jest.fn(), logLLMRequest: jest.fn(), logLLMResponse: jest.fn() } as any;

    await manager.callProvider(
      provider,
      'model-x',
      {},
      [],
      [],
      undefined,
      {
        routing: ['main'],
        provider: { order: ['fast'] },
        passthrough: true
      },
      logger
    );

    expect(compat.buildPayload).toHaveBeenCalled();
    expect(compat.applyProviderExtensions).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ provider: { order: ['fast'] }, passthrough: true })
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Extra field not supported by provider',
      expect.objectContaining({ field: 'passthrough', value: '***' })
    );
  });
  test('callProvider works when compat applyProviderExtensions missing', async () => {
    const compat = createCompat();
    delete compat.applyProviderExtensions;
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({ status: 200, data: { choices: [], usage: {} } })
    };
    (manager as any).httpClient = httpClient;

    const logger = { info: jest.fn(), logLLMRequest: jest.fn(), logLLMResponse: jest.fn() } as any;

    await manager.callProvider(provider, 'model-x', {}, [], [], undefined, {}, logger);

    expect(compat.buildPayload).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      'Extra field not supported by provider',
      expect.objectContaining({ field: expect.any(String) })
    );
  });

  test('calls provider, applies payload extensions, logs, and parses response', async () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({
        status: 200,
        data: { choices: [], usage: {} }
      })
    };
    (manager as any).httpClient = httpClient;

    const logger = {
      info: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    const response = await manager.callProvider(
      provider,
      'model-x',
      {},
      [],
      [],
      undefined,
      { routing: ['tool'], providerOverrides: { temperature: 0.1 } },
      logger
    );

    expect(httpClient.request).toHaveBeenCalledWith({
      method: 'POST',
      url: 'http://service/model-x',
      headers: provider.endpoint.headers,
      data: expect.objectContaining({
        metadata: { routing: ['tool'] },
        extended: true
        // Note: providerOverrides is NOT in payload because it's not declared in
        // provider.payloadExtensions and compat.applyProviderExtensions doesn't add it
      })
    });

    expect(compat.buildPayload).toHaveBeenCalled();
    expect(compat.applyProviderExtensions).toHaveBeenCalled();
    expect(compat.parseResponse).toHaveBeenCalled();
    expect(logger.logLLMRequest).toHaveBeenCalled();
    expect(logger.logLLMResponse).toHaveBeenCalled();
    const responseLog = (logger.logLLMResponse as any).mock.calls[0][0];
    expect(typeof responseLog.duration).toBe('number');
    expect(responseLog.duration).toBeGreaterThanOrEqual(0);
    expect(response.provider).toBe('test-openai');

    // Verify that unconsumed extra field triggered a warning
    expect(logger.info).toHaveBeenCalledWith(
      'Extra field not supported by provider',
      expect.objectContaining({
        provider: 'test-openai',
        field: 'providerOverrides',
        value: '***'
      })
    );
  });

  test('throws ProviderExecutionError with rate limit detection', async () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({
        status: 429,
        data: { error: 'limit exceeded' }
      })
    };
    (manager as any).httpClient = httpClient;

    const logger = {
      warning: jest.fn(),
      error: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    await expect(
      manager.callProvider(provider, 'model-x', {}, [], [], undefined, {}, logger)
    ).rejects.toEqual(expect.any(ProviderExecutionError));
  });

  test('logs error payloads and rate limit details when response >= 400', async () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({
        status: 503,
        data: { error: 'SERVICE LIMIT' },
        headers: { 'x-error': 'limit reached' }
      })
    };
    (manager as any).httpClient = httpClient;

    const logger = {
      error: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    await expect(
      manager.callProvider(provider, 'model-x', {}, [], [], undefined, {}, logger)
    ).rejects.toEqual(expect.any(ProviderExecutionError));

    expect(logger.error).toHaveBeenCalledWith('Provider call failed', {
      provider: provider.id,
      model: 'model-x',
      status: 503,
      isRateLimit: true
    });
  });

  test('wraps unexpected transport errors as ProviderExecutionError', async () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockRejectedValue(new Error('network down'))
    };
    (manager as any).httpClient = httpClient;

    await expect(
      manager.callProvider(provider, 'model-x', {}, [], [])
    ).rejects.toThrow('[test-openai] network down');
  });

  test('wraps unexpected SDK setup errors as ProviderExecutionError', async () => {
    const compat = { callSDK: jest.fn() };
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const sdkProvider = {
      ...provider,
      endpoint: {
        ...provider.endpoint,
        urlTemplate: 'sdk://service/{model}'
      }
    };

    const logger = {
      info: () => {
        throw new Error('logger boom');
      }
    } as any;

    await expect(
      manager.callProvider(sdkProvider, 'model-x', {}, [], [], undefined, {}, logger)
    ).rejects.toThrow('[test-openai] logger boom');
  });

  test('streamProvider yields parsed SSE chunks and skips invalid rows', async () => {
    const compat = {
      buildPayload: jest.fn(() => ({ base: true })),
      getStreamingFlags: jest.fn(() => ({ stream: true })),
      applyProviderExtensions: jest.fn((payload: any) => ({ ...payload, extended: true }))
    };
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const chunks = [
      'data: {"id":1}\n',
      '\n',
      ':comment\n',
      'data: not-json\n',
      'data: {"id":2}\n',
      'data: [DONE]\n'
    ];

    const httpClient = {
      request: jest.fn().mockResolvedValue({
        data: {
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
              yield Buffer.from(chunk);
            }
          }
        }
      })
    };
    (manager as any).httpClient = httpClient;

    const logger = {
      info: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    const received: any[] = [];
    for await (const chunk of manager.streamProvider(
      provider,
      'model-x',
      {},
      [],
      [],
      undefined,
      { passthrough: true },
      logger
    )) {
      received.push(chunk);
    }

    expect(received).toEqual([{ id: 1 }, { id: 2 }]);
    expect(httpClient.request).toHaveBeenCalledWith({
      method: 'POST',
      url: 'http://service/model-x',
      headers: provider.endpoint.headers,
      data: expect.objectContaining({ base: true, stream: true, extended: true }),
      responseType: 'stream'
    });
  });

  test('streamProvider works without provider extras', async () => {
    const compat = {
      buildPayload: jest.fn(() => ({ base: true })),
      getStreamingFlags: jest.fn(() => ({ stream: true }))
    } as any;
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    (manager as any).httpClient = {
      request: jest.fn().mockResolvedValue({
        data: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('data: {"id":42}\n');
            yield Buffer.from('data: [DONE]\n');
          }
        }
      })
    };

    const chunks: any[] = [];
    for await (const chunk of manager.streamProvider(provider, 'model-x', {} as any, [], [])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ id: 42 }]);
    expect(compat.buildPayload).toHaveBeenCalled();
  });

  test('isRateLimitResponse returns false when no keywords', () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const result = (manager as any).isRateLimitResponse(
      { ...provider, retryWords: [] },
      { data: { message: 'ok' }, headers: {} }
    );
    expect(result).toBe(false);
  });

  test('isRateLimitResponse returns false when keywords only appear in x-ratelimit headers', () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const result = (manager as any).isRateLimitResponse(
      { ...provider, retryWords: ['rate', 'limit'] },
      {
        status: 400,
        data: { error: { code: 'unsupported_parameter', param: 'reasoning.effort' } },
        headers: { 'x-ratelimit-limit-requests': '10000', 'x-ratelimit-remaining-requests': '9999' }
      }
    );

    expect(result).toBe(false);
  });

  test('callProvider handles missing provider extras gracefully', async () => {
    const compat = {
      buildPayload: jest.fn(() => ({ base: true })),
      parseResponse: jest.fn(() => ({ role: 'assistant', content: [] })),
      applyProviderExtensions: undefined
    };

    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    (manager as any).httpClient = {
      request: jest.fn().mockResolvedValue({ status: 200, data: { choices: [{ message: {} }] } })
    };

    const response = await manager.callProvider(provider, 'model-x', {} as any, [], []);
    expect(response.provider).toBe('test-openai');
    expect(compat.buildPayload).toHaveBeenCalled();
  });

  test('callProvider handles providers without payloadExtensions', async () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    (manager as any).httpClient = {
      request: jest.fn().mockResolvedValue({ status: 200, data: { choices: [], usage: {} } })
    };

    const providerWithoutExtensions = { ...provider, payloadExtensions: undefined };

    await manager.callProvider(
      providerWithoutExtensions,
      'model-x',
      {} as any,
      [],
      [],
      undefined,
      { passthrough: true }
    );

    expect(compat.applyProviderExtensions).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ passthrough: true })
    );
  });

  test('isRateLimitResponse returns true for HTTP 429 responses', () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const result = (manager as any).isRateLimitResponse(
      provider,
      { status: 429, data: { message: 'rate limit exceeded' }, headers: { 'x-ratelimit-limit-requests': '10000' } }
    );
    expect(result).toBe(true);
  });

  test('isRateLimitResponse returns true when Retry-After header is present', () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const result = (manager as any).isRateLimitResponse(
      provider,
      { status: 503, data: { error: 'overloaded' }, headers: { 'retry-after': '1' } }
    );

    expect(result).toBe(true);
  });

  test('stripReasoning returns payload unchanged for non-objects and objects without reasoning', () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    expect((manager as any).stripReasoning(null)).toBeNull();
    expect((manager as any).stripReasoning([1, 2, 3])).toEqual([1, 2, 3]);
    expect((manager as any).stripReasoning({ foo: 'bar' })).toEqual({ foo: 'bar' });
  });

  test('isReasoningExplicitlyDisabled detects enabled=false or exclude=true', () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    expect((manager as any).isReasoningExplicitlyDisabled({})).toBe(false);
    expect((manager as any).isReasoningExplicitlyDisabled({ reasoning: null })).toBe(false);
    expect((manager as any).isReasoningExplicitlyDisabled({ reasoning: { effort: 'low' } })).toBe(false);
    expect((manager as any).isReasoningExplicitlyDisabled({ reasoning: { enabled: false } })).toBe(true);
    expect((manager as any).isReasoningExplicitlyDisabled({ reasoning: { exclude: true } })).toBe(true);
  });

  test('isUnsupportedReasoningParamError handles missing/partial error shapes', () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    expect((manager as any).isUnsupportedReasoningParamError({})).toBe(false);
    expect((manager as any).isUnsupportedReasoningParamError({ error: { code: 'nope' } })).toBe(false);
    expect(
      (manager as any).isUnsupportedReasoningParamError({
        error: { code: 'unsupported_parameter', param: 'temperature', message: 123 }
      })
    ).toBe(false);

    expect(
      (manager as any).isUnsupportedReasoningParamError({
        error: {
          code: 'unsupported_parameter',
          message: "Unsupported parameter: 'reasoning.effort' is not supported with this model."
        }
      })
    ).toBe(true);
  });

  test('isReasoningDisabledNotAllowedError detects "reasoning cannot be disabled" message', () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    expect((manager as any).isReasoningDisabledNotAllowedError({})).toBe(false);
    expect((manager as any).isReasoningDisabledNotAllowedError({ error: {} })).toBe(false);
    expect(
      (manager as any).isReasoningDisabledNotAllowedError({
        error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' }
      })
    ).toBe(true);
    expect(
      (manager as any).isReasoningDisabledNotAllowedError({
        error: { message: 'Reasoning cannot be DISABLED.' }
      })
    ).toBe(true);
  });

  test('callProvider retries once without reasoning when reasoning param is unsupported', async () => {
    const originalLive = process.env.LLM_LIVE;
    process.env.LLM_LIVE = '1';
    try {
      const compat = {
        buildPayload: jest.fn(() => ({ metadata: {}, reasoning: { effort: 'low' } })),
        parseResponse: jest.fn(() => ({ role: 'assistant', content: [] })),
        applyProviderExtensions: jest.fn((payload: any) => payload)
      };

      const registry = { getCompatModule: jest.fn(() => compat) } as any;
      const manager = new LLMManager(registry);

      const httpClient = {
        request: jest
          .fn()
          .mockResolvedValueOnce({
            status: 400,
            statusText: 'Bad Request',
            headers: { 'x-ratelimit-limit-requests': '10000' },
            data: {
              error: {
                message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
                type: 'invalid_request_error',
                param: 'reasoning.effort',
                code: 'unsupported_parameter'
              }
            }
          })
          .mockResolvedValueOnce({
            status: 200,
            statusText: 'OK',
            headers: {},
            data: { choices: [], usage: {} }
          })
      };
      (manager as any).httpClient = httpClient;

      const logger = {
        logLLMRequest: jest.fn(),
        logLLMResponse: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        info: jest.fn()
      } as any;

      const response = await manager.callProvider(provider, 'model-x', {} as any, [], [], undefined, {}, logger);

      expect(response.provider).toBe(provider.id);
      expect(httpClient.request).toHaveBeenCalledTimes(2);
      const firstPayload = httpClient.request.mock.calls[0][0].data;
      const secondPayload = httpClient.request.mock.calls[1][0].data;
      expect(firstPayload.reasoning).toBeDefined();
      expect(secondPayload.reasoning).toBeUndefined();
    } finally {
      if (originalLive !== undefined) {
        process.env.LLM_LIVE = originalLive;
      } else {
        delete process.env.LLM_LIVE;
      }
    }
  });

  test('callProvider retries once without reasoning when explicit disable is rejected', async () => {
    const originalLive = process.env.LLM_LIVE;
    process.env.LLM_LIVE = '1';
    try {
    const compat = {
      buildPayload: jest.fn(() => ({ metadata: {}, reasoning: { enabled: false } })),
      parseResponse: jest.fn(() => ({ role: 'assistant', content: [] })),
      applyProviderExtensions: jest.fn((payload: any) => payload)
    };

    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest
        .fn()
        .mockResolvedValueOnce({
          status: 400,
          statusText: 'Bad Request',
          headers: {},
          data: {
            error: {
              message: 'Reasoning is mandatory for this endpoint and cannot be disabled.',
              code: 400
            }
          }
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: {},
          data: { choices: [], usage: {} }
        })
    };
    (manager as any).httpClient = httpClient;

    const logger = {
      warning: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    await manager.callProvider(provider, 'model-x', {} as any, [], [], undefined, {}, logger);

    expect(httpClient.request).toHaveBeenCalledTimes(2);
    const firstPayload = httpClient.request.mock.calls[0][0].data;
    const secondPayload = httpClient.request.mock.calls[1][0].data;
    expect(firstPayload.reasoning).toBeDefined();
    expect(secondPayload.reasoning).toBeUndefined();
    } finally {
      if (originalLive !== undefined) {
        process.env.LLM_LIVE = originalLive;
      } else {
        delete process.env.LLM_LIVE;
      }
    }
  });

  test('callProvider strips reasoning upfront after caching unsupported reasoning for provider+model', async () => {
    const compat = {
      buildPayload: jest.fn(() => ({ metadata: {}, reasoning: { effort: 'low' } })),
      parseResponse: jest.fn(() => ({ role: 'assistant', content: [] })),
      applyProviderExtensions: jest.fn((payload: any) => payload)
    };

    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest
        .fn()
        .mockResolvedValueOnce({
          status: 400,
          statusText: 'Bad Request',
          headers: {},
          data: {
            error: {
              message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
              type: 'invalid_request_error',
              param: 'reasoning.effort',
              code: 'unsupported_parameter'
            }
          }
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: {},
          data: { choices: [], usage: {} }
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: 'OK',
          headers: {},
          data: { choices: [], usage: {} }
        })
    };
    (manager as any).httpClient = httpClient;

    // First call: trigger cache + retry
    await manager.callProvider(provider, 'model-x', {} as any, [], [], undefined, {});

    // Second call: should strip reasoning before first request (no retry required)
    await manager.callProvider(provider, 'model-x', {} as any, [], [], undefined, {});

    expect(httpClient.request).toHaveBeenCalledTimes(3);
    const thirdPayload = httpClient.request.mock.calls[2][0].data;
    expect(thirdPayload.reasoning).toBeUndefined();
  });

  test('httpClient validateStatus always accepts response codes', () => {
    const compat = createCompat();
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const validateStatus = (manager as any).httpClient.defaults.validateStatus;
    expect(validateStatus(200)).toBe(true);
    expect(validateStatus(503)).toBe(true);
  });

  test('callProvider executes LLM_LIVE logging paths when LLM_LIVE=1', async () => {
    const originalEnv = process.env.LLM_LIVE;
    process.env.LLM_LIVE = '1';

    try {
      const compat = createCompat();
      const registry = { getCompatModule: jest.fn(() => compat) } as any;
      const manager = new LLMManager(registry);

      (manager as any).httpClient = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          data: { choices: [], usage: {} }
        })
      };

      // The code will attempt to dynamically import test-logger when LLM_LIVE=1
      // The import will fail in the test environment, but the code path is executed
      await manager.callProvider(
        provider,
        'test-model',
        {},
        [],
        [],
        undefined
      );

      // Verify the request was made (proving the LLM_LIVE code path was executed)
      expect((manager as any).httpClient.request).toHaveBeenCalled();
    } finally {
      if (originalEnv !== undefined) {
        process.env.LLM_LIVE = originalEnv;
      } else {
        delete process.env.LLM_LIVE;
      }
    }
  });

  test('streamProvider executes LLM_LIVE logging paths when LLM_LIVE=1', async () => {
    const originalEnv = process.env.LLM_LIVE;
    process.env.LLM_LIVE = '1';

    try {
      const compat = {
        buildPayload: jest.fn(() => ({ base: true })),
        getStreamingFlags: jest.fn(() => ({ stream: true }))
      };
      const registry = { getCompatModule: jest.fn(() => compat) } as any;
      const manager = new LLMManager(registry);

      const chunks = ['data: {"id":1}\n', 'data: [DONE]\n'];
      const httpClient = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/event-stream' },
          data: {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) {
                yield Buffer.from(chunk);
              }
            }
          }
        })
      };
      (manager as any).httpClient = httpClient;

      // The code will attempt to dynamically import test-logger when LLM_LIVE=1
      // The import will fail in the test environment, but the code path is executed
      const received: any[] = [];
      for await (const chunk of manager.streamProvider(
        provider,
        'test-model',
        {},
        [],
        []
      )) {
        received.push(chunk);
      }

      // Verify the request was made and chunks received (proving the LLM_LIVE code path was executed)
      expect((manager as any).httpClient.request).toHaveBeenCalled();
      expect(received).toEqual([{ id: 1 }]);
    } finally {
      if (originalEnv !== undefined) {
        process.env.LLM_LIVE = originalEnv;
      } else {
        delete process.env.LLM_LIVE;
      }
    }
  });

  test('streamProvider handles error responses with status >= 400', async () => {
    const compat = {
      buildPayload: jest.fn(() => ({ base: true })),
      getStreamingFlags: jest.fn(() => ({ stream: true }))
    };
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const errorChunks = ['{"error": "Bad Request"}'];
    const httpClient = {
      request: jest.fn().mockResolvedValue({
        status: 400,
        headers: { 'content-type': 'application/json' },
        data: {
          async *[Symbol.asyncIterator]() {
            for (const chunk of errorChunks) {
              yield Buffer.from(chunk);
            }
          }
        }
      })
    };
    (manager as any).httpClient = httpClient;

    const logger = {
      error: jest.fn(),
      info: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn()
    } as any;

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const chunk of manager.streamProvider(
        provider,
        'model-x',
        {},
        [],
        [],
        undefined,
        {},
        logger
      )) {
        // Should not reach here
      }
    }).rejects.toThrow(ProviderExecutionError);

    expect(logger.error).toHaveBeenCalledWith(
      'Streaming request failed',
      expect.objectContaining({
        provider: provider.id,
        model: 'model-x',
        status: 400
      })
    );
  });

  test('streamProvider detects rate limit in error responses', async () => {
    const compat = {
      buildPayload: jest.fn(() => ({ base: true })),
      getStreamingFlags: jest.fn(() => ({ stream: true }))
    };
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const errorChunks = ['Rate limit exceeded'];
    const httpClient = {
      request: jest.fn().mockResolvedValue({
        status: 429,
        headers: { 'x-ratelimit': 'true' },
        data: {
          async *[Symbol.asyncIterator]() {
            for (const chunk of errorChunks) {
              yield Buffer.from(chunk);
            }
          }
        }
      })
    };
    (manager as any).httpClient = httpClient;

    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const chunk of manager.streamProvider(
        provider,
        'model-x',
        {},
        [],
        []
      )) {
        // Should not reach here
      }
      fail('Should have thrown ProviderExecutionError');
    } catch (error: any) {
      expect(error).toBeInstanceOf(ProviderExecutionError);
      expect(error.isRateLimit).toBe(true);
    }
  });

  test('streamProvider handles provider with no headers or streamingHeaders', async () => {
    const providerNoHeaders = {
      id: 'test-no-headers',
      compat: 'openai',
      endpoint: {
        urlTemplate: 'http://service/{model}',
        method: 'POST'
        // No headers or streamingHeaders
      }
    } as any;

    const compat = {
      buildPayload: jest.fn(() => ({ base: true })),
      getStreamingFlags: jest.fn(() => ({ stream: true }))
    } as any;
    const registry = { getCompatModule: jest.fn(() => compat) } as any;
    const manager = new LLMManager(registry);

    const httpClient = {
      request: jest.fn().mockResolvedValue({
        data: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('data: {"id":99}\n');
            yield Buffer.from('data: [DONE]\n');
          }
        }
      })
    };
    (manager as any).httpClient = httpClient;

    const chunks: any[] = [];
    for await (const chunk of manager.streamProvider(providerNoHeaders, 'model-x', {} as any, [], [])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ id: 99 }]);
    // Verify that empty headers object is passed when provider has no headers
    expect(httpClient.request).toHaveBeenCalledWith({
      method: 'POST',
      url: 'http://service/model-x',
      headers: {},
      data: expect.objectContaining({ base: true, stream: true }),
      responseType: 'stream'
    });
  });
});
