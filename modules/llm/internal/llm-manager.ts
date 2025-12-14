import axios, { AxiosInstance } from 'axios';
import type {
  ProviderManifest,
  LLMCallSettings,
  Message,
  UnifiedTool,
  ToolChoice,
  LLMResponse
} from '../../kernel/index.js';
import { ProviderExecutionError, getDefaults } from '../../kernel/index.js';
import type { AdapterLogger } from '../../logging/index.js';
import { buildFinalPayload } from '../../../utils/provider/payload-builder.js';

export class LLMManager {
  private httpClient: AxiosInstance;

  constructor(private registry: any) {
    this.httpClient = axios.create({
      timeout: getDefaults().timeouts.llmHttp,
      validateStatus: () => true // Handle all status codes
    });
  }

  async callProvider(
    provider: ProviderManifest,
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    providerExtras: Record<string, any> = {},
    logger?: AdapterLogger,
    context?: any
  ): Promise<LLMResponse> {
    const compat = await this.registry.getCompatModule(provider.compat);

    // SDK-based providers: if compat has callSDK method, use it instead of HTTP
    if (typeof compat.callSDK === 'function') {
      if (logger) {
        logger.info('Using SDK-based compat', { provider: provider.id, model });

        // Log warnings for unconsumed provider extras (SDK methods don't consume them)
        for (const [field, value] of Object.entries(providerExtras)) {
          // Log to both AdapterLogger and console.error (for live test detection)
          const msg = `Extra field not supported by provider: "${field}" is not supported by ${provider.id} and was not sent to the API`;
          logger.info(msg, {
            provider: provider.id,
            field,
            value
          });
          // Log to stderr for live test expectations
          if (process.env.LLM_LIVE === '1') {
            console.error(JSON.stringify({
              timestamp: new Date().toISOString(),
              level: 'info',
              message: msg,
              data: { provider: provider.id, field, value }
            }));
          }
        }

        // Log SDK request using existing logging infrastructure
        logger.logLLMRequest({
          url: `SDK:${provider.id}/${model}`,
          method: 'SDK_CALL',
          headers: {},
          body: { model, messages, tools, toolChoice, settings, providerExtras }
        });
      }

      // Log raw request for live tests
      if (process.env.LLM_LIVE === '1') {
        try {
          const { logRequest } = await import('../../../tests/live/test-logger.js');
          logRequest({
            url: `SDK:${provider.id}/${model}`,
            method: 'SDK_CALL',
            headers: {},
            body: { model, messages, tools, toolChoice, settings, providerExtras }
          });
        } catch (e) {
          // Test logger not available, skip
        }
      }

      try {
        const response = await compat.callSDK(model, settings, messages, tools, toolChoice, logger, provider.endpoint.headers);
        response.toolCalls = await this.normalizeToolCallsIfPresent(response.toolCalls);
        response.provider = provider.id;

        // Log SDK response using existing logging infrastructure
        if (logger) {
          logger.logLLMResponse({
            status: 200,
            statusText: 'SDK_SUCCESS',
            headers: {},
            body: response
          });
        }

        // Log raw response for live tests
        if (process.env.LLM_LIVE === '1') {
          try {
            const { logResponse } = await import('../../../tests/live/test-logger.js');
            logResponse({
              status: 200,
              statusText: 'SDK_SUCCESS',
              headers: {},
              body: response
            });
          } catch (e) {
            // Test logger not available, skip
          }
        }

        return response;
      } catch (error: any) {
        if (error instanceof ProviderExecutionError) {
          throw error;
        }
        throw new ProviderExecutionError(provider.id, error.message);
      }
    }

    // HTTP-based providers: proceed with standard HTTP flow
    const { payload: finalPayload, unconsumedExtras } = buildFinalPayload({
      provider,
      compat,
      model,
      settings,
      messages,
      tools,
      toolChoice,
      providerExtras
    });

    if (logger) {
      for (const [field, value] of Object.entries(unconsumedExtras)) {
        logger.info('Extra field not supported by provider', {
          provider: provider.id,
          field,
          value,
          message: `Field "${field}" is not supported by ${provider.id} and was not sent to the API. Check provider payloadExtensions or compat module.`
        });
      }
    }
    
    // Build request
    const url = provider.endpoint.urlTemplate.replace('{model}', model);

    if (logger) {
      // Log beautiful formatted LLM request to dedicated log file
      logger.logLLMRequest({
        url,
        method: provider.endpoint.method,
        headers: provider.endpoint.headers,
        body: finalPayload
      });
    }

    // Log raw request for live tests (always on when LLM_LIVE=1)
    if (process.env.LLM_LIVE === '1') {
      try {
        const { logRequest } = await import('../../../tests/live/test-logger.js');
        logRequest({
          url,
          method: provider.endpoint.method,
          headers: provider.endpoint.headers,
          body: finalPayload
        });
      } catch (e) {
        // Test logger not available, skip
      }
    }

    try {
      const response = await this.httpClient.request({
        method: provider.endpoint.method,
        url,
        headers: provider.endpoint.headers,
        data: finalPayload
      });

      // Log beautiful formatted LLM response to dedicated log file
      if (logger) {
        logger.logLLMResponse({
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: response.data
        });
      }

      // Log raw response for live tests (always on when LLM_LIVE=1)
      if (process.env.LLM_LIVE === '1') {
        try {
          const { logResponse } = await import('../../../tests/live/test-logger.js');
          logResponse({
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.data
          });
        } catch (e) {
          // Test logger not available, skip
        }
      }

      if (response.status >= 400) {
        const isRateLimit = this.isRateLimitResponse(provider, response);

        if (logger) {
          logger.error('Provider call failed', {
            provider: provider.id,
            model,
            status: response.status,
            isRateLimit
          });
        }

        throw new ProviderExecutionError(
          provider.id,
          JSON.stringify(response.data),
          response.status,
          isRateLimit
        );
      }
      
      const parsed = compat.parseResponse(response.data, model);
      parsed.toolCalls = await this.normalizeToolCallsIfPresent(parsed.toolCalls);
      parsed.provider = provider.id;
      return parsed;
      
    } catch (error: any) {
      if (error instanceof ProviderExecutionError) {
        throw error;
      }
      throw new ProviderExecutionError(provider.id, error.message);
    }
  }

  async *streamProvider(
    provider: ProviderManifest,
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    providerExtras: Record<string, any> = {},
    logger?: AdapterLogger
  ): AsyncGenerator<any> {
    const compat = await this.registry.getCompatModule(provider.compat);

    logger?.info('streamProvider called', { provider: provider.id, model, messagesCount: messages.length });

    // SDK-based providers: if compat has streamSDK method, use it instead of HTTP
    if (typeof compat.streamSDK === 'function') {
      if (logger) {
        logger.info('Using SDK-based streaming compat', { provider: provider.id, model });
      }

      // Log raw request for live tests
      if (process.env.LLM_LIVE === '1') {
        try {
          const { logRequest } = await import('../../../tests/live/test-logger.js');
          logRequest({
            url: `SDK:${provider.id}/${model}`,
            method: 'SDK_STREAM',
            headers: {},
            body: { model, messages, tools, toolChoice, settings, providerExtras }
          });
        } catch (e) {
          // test-logger not available (not in test environment), skip logging
        }
      }

      const streamedChunks: any[] = [];
      const shouldLogLive = process.env.LLM_LIVE === '1';

      try {
        for await (const chunk of compat.streamSDK(model, settings, messages, tools, toolChoice, logger, provider.endpoint.headers)) {
          if (shouldLogLive) {
            streamedChunks.push(chunk);
          }
          yield chunk;
        }

        // Log the complete streamed response for live tests
        if (shouldLogLive) {
          try {
            const { logResponse } = await import('../../../tests/live/test-logger.js');
            logResponse({
              status: 200,
              statusText: 'SDK_SUCCESS',
              headers: {},
              body: { chunks: streamedChunks, totalChunks: streamedChunks.length }
            });
          } catch (e) {
            // test-logger not available (not in test environment), skip logging
          }
        }

        return;
      } catch (error: any) {
        if (error instanceof ProviderExecutionError) {
          throw error;
        }
        throw new ProviderExecutionError(provider.id, error.message);
      }
    }

    // HTTP-based providers: proceed with standard HTTP streaming flow
    const { payload: finalPayload, unconsumedExtras } = buildFinalPayload({
      provider,
      compat,
      model,
      settings,
      messages,
      tools,
      toolChoice,
      providerExtras,
      streaming: true
    });

    if (logger) {
      for (const [field, value] of Object.entries(unconsumedExtras)) {
        logger.info('Extra field not supported by provider', {
          provider: provider.id,
          field,
          value,
          message: `Field "${field}" is not supported by ${provider.id} and was not sent to the API. Check provider payloadExtensions or compat module.`
        });
      }
    }

    const url = (provider.endpoint.streamingUrlTemplate || provider.endpoint.urlTemplate).replace('{model}', model);

    logger?.info('About to make streaming HTTP request', { url, messagesCount: messages.length });

    // Log raw request for live tests (always on when LLM_LIVE=1)
    if (process.env.LLM_LIVE === '1') {
      try {
        const { logRequest } = await import('../../../tests/live/test-logger.js');
        logRequest({
          url,
          method: provider.endpoint.method,
          headers: provider.endpoint.headers,
          body: finalPayload
        });
      } catch (e) {
        // test-logger not available (not in test environment), skip logging
      }
    }

    const mergedHeaders = { ...(provider.endpoint.headers || {}), ...(provider.endpoint.streamingHeaders || {}) };

    const response = await this.httpClient.request({
      method: provider.endpoint.method,
      url,
      headers: mergedHeaders,
      data: finalPayload,
      responseType: 'stream'
    });

    logger?.info('HTTP response received for streaming', { statusCode: response.status });

    // For live tests, log response headers immediately (body will be logged as chunks arrive)
    const streamedChunks: any[] = [];
    const shouldLogLive = process.env.LLM_LIVE === '1';

    // Handle error responses
    if (response.status >= 400) {
      let errorBody = '';
      for await (const chunk of response.data) {
        errorBody += chunk.toString();
      }

      logger?.error('Streaming request failed', {
        provider: provider.id,
        model,
        status: response.status,
        body: errorBody
      });

      const isRateLimit = this.isRateLimitResponse(provider, { status: response.status, data: errorBody, headers: response.headers });

      throw new ProviderExecutionError(
        provider.id,
        errorBody,
        response.status,
        isRateLimit
      );
    }

    let buffer = '';
    let chunkCount = 0;

    for await (const chunk of response.data) {
      chunkCount++;
      logger?.info('Received chunk from response.data', { chunkNumber: chunkCount, chunkSize: chunk.length });
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || line === ':') continue;

        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (shouldLogLive) {
              streamedChunks.push(parsed);
            }
            yield parsed;
          } catch (e) {
            // Invalid JSON, skip
          }
        }
      }
    }

    // Log the complete streamed response for live tests
    if (shouldLogLive) {
      try {
        const { logResponse } = await import('../../../tests/live/test-logger.js');
        logResponse({
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: { chunks: streamedChunks, totalChunks: streamedChunks.length }
        });
      } catch (e) {
        // test-logger not available (not in test environment), skip logging
      }
    }
  }

  private async normalizeToolCallsIfPresent(toolCalls: any): Promise<any> {
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      return toolCalls;
    }

    const { normalizeToolCalls } = await import('../../tools/index.js');
    return normalizeToolCalls(toolCalls);
  }

  private isRateLimitResponse(provider: ProviderManifest, response: any): boolean {
    if (!provider.retryWords || provider.retryWords.length === 0) {
      return false;
    }
    
    const keywords = provider.retryWords.map(w => w.toLowerCase());
    const responseText = JSON.stringify(response.data).toLowerCase();
    const headersText = JSON.stringify(response.headers).toLowerCase();
    const combined = responseText + ' ' + headersText;
    
    return keywords.some(keyword => combined.includes(keyword));
  }
}
