import axios, { AxiosInstance } from 'axios';
import type {
  ProviderManifest,
  LLMCallSettings,
  Message,
  UnifiedTool,
  ToolChoice,
  LLMResponse,
  AdapterLogger
} from '../../kernel/index.js';
import { ProviderExecutionError, getDefaults } from '../../kernel/index.js';
import { aggregateSystemMessages } from '../../messages/index.js';
import { buildFinalPayload } from './payload/payload-builder.js';

export class LLMManager {
  private httpClient: AxiosInstance;
  private reasoningUnsupportedByProviderModel = new Set<string>();

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
    context: any = {}
  ): Promise<LLMResponse> {
    const normalizedMessages = aggregateSystemMessages(messages);
    const compat = await this.registry.getCompatModule(provider.compat);
    const providerRequestsHttp = this.isHttpUrlTemplate(provider.endpoint?.urlTemplate);

    // SDK-based providers: if compat has callSDK method, use it instead of HTTP
    if (!providerRequestsHttp && typeof compat.callSDK === 'function') {
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
          body: { model, messages: normalizedMessages, tools, toolChoice, settings, providerExtras }
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
            body: { model, messages: normalizedMessages, tools, toolChoice, settings, providerExtras }
          }, context.metadata);
        } catch (e) {
          // Test logger not available, skip
        }
      }

      try {
        const response = await compat.callSDK(model, settings, normalizedMessages, tools, toolChoice, logger, provider.endpoint.headers);
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
            }, context.metadata);
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
    const cacheKey = `${provider.id}:${model}`;
    const { payload: rawPayload, unconsumedExtras } = buildFinalPayload({
      provider,
      compat,
      model,
      settings,
      messages: normalizedMessages,
      tools,
      toolChoice,
      providerExtras
    });
    const shouldStripReasoning =
      process.env.LLM_LIVE !== '1' && this.reasoningUnsupportedByProviderModel.has(cacheKey);
    const finalPayload = shouldStripReasoning ? this.stripReasoning(rawPayload) : rawPayload;

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

    try {
      const sendRequest = async (payload: any) => {
        // Log beautiful formatted LLM request to dedicated log file
        if (logger) {
          logger.logLLMRequest({
            url,
            method: provider.endpoint.method,
            headers: provider.endpoint.headers,
            body: payload
          });
        }

        // Log raw request for live tests (always on when LLM_LIVE=1)
        if (process.env.LLM_LIVE === '1') {
          try {
            const { logRequest } = await import('../../../tests/live/test-logger.js');
            logRequest(
              {
                url,
                method: provider.endpoint.method,
                headers: provider.endpoint.headers,
                body: payload
              },
              context.metadata
            );
          } catch (e) {
            // Test logger not available, skip
          }
        }

        return this.httpClient.request({
          method: provider.endpoint.method,
          url,
          headers: provider.endpoint.headers,
          data: payload
        });
      };

      let response = await sendRequest(finalPayload);

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
          }, context.metadata);
        } catch (e) {
          // Test logger not available, skip
        }
      }

      if (response.status >= 400) {
        // Retry once without reasoning if the provider rejects reasoning parameters.
        // This keeps runs resilient when optional features are requested but unsupported by the target model.
        if (this.isUnsupportedReasoningParamError(response.data) && finalPayload?.reasoning !== undefined) {
          this.reasoningUnsupportedByProviderModel.add(cacheKey);

          logger?.warning('Provider rejected reasoning parameters; retrying without reasoning', {
            provider: provider.id,
            model
          });

          const retryPayload = this.stripReasoning(finalPayload);
          response = await sendRequest(retryPayload);

          // Log response for retry attempt
          if (logger) {
            logger.logLLMResponse({
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              body: response.data
            });
          }

          if (process.env.LLM_LIVE === '1') {
            try {
              const { logResponse } = await import('../../../tests/live/test-logger.js');
              logResponse(
                {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                  body: response.data
                },
                context.metadata
              );
            } catch (e) {
              // Test logger not available, skip
            }
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
    logger?: AdapterLogger,
    context: any = {}
  ): AsyncGenerator<any> {
    const normalizedMessages = aggregateSystemMessages(messages);
    const compat = await this.registry.getCompatModule(provider.compat);
    const providerRequestsHttp = this.isHttpUrlTemplate(
      provider.endpoint?.streamingUrlTemplate || provider.endpoint?.urlTemplate
    );

    logger?.info('streamProvider called', { provider: provider.id, model, messagesCount: messages.length });

    // SDK-based providers: if compat has streamSDK method, use it instead of HTTP
    if (!providerRequestsHttp && typeof compat.streamSDK === 'function') {
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
            body: { model, messages: normalizedMessages, tools, toolChoice, settings, providerExtras }
          }, context.metadata);
        } catch (e) {
          // test-logger not available (not in test environment), skip logging
        }
      }

      const streamedChunks: any[] = [];
      const shouldLogLive = process.env.LLM_LIVE === '1';

      try {
        for await (const chunk of compat.streamSDK(model, settings, normalizedMessages, tools, toolChoice, logger, provider.endpoint.headers)) {
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
            }, context.metadata);
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
      messages: normalizedMessages,
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
        }, context.metadata);
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
        }, context.metadata);
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

    // Treat HTTP 429 as rate limit regardless of body shape.
    if (response?.status === 429) {
      return true;
    }

    // A Retry-After header is a strong signal even when bodies are not standardized.
    const retryAfter = response?.headers?.['retry-after'] ?? response?.headers?.['Retry-After'];
    if (retryAfter !== undefined && retryAfter !== null && String(retryAfter).trim() !== '') {
      return true;
    }

    const keywords = provider.retryWords.map(w => w.toLowerCase());
    const responseText = JSON.stringify(response.data).toLowerCase();
    return keywords.some(keyword => responseText.includes(keyword));
  }

  private stripReasoning(payload: any): any {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'reasoning')) {
      return payload;
    }

    const next = { ...payload };
    delete next.reasoning;
    return next;
  }

  private isUnsupportedReasoningParamError(data: any): boolean {
    const error = data?.error;
    if (!error || typeof error !== 'object') {
      return false;
    }

    const code = (error as any).code;
    if (code !== 'unsupported_parameter') {
      return false;
    }

    const param = (error as any).param;
    if (typeof param === 'string' && (param === 'reasoning' || param.startsWith('reasoning.'))) {
      return true;
    }

    const message = (error as any).message;
    if (typeof message === 'string') {
      const normalized = message.toLowerCase();
      return normalized.includes('unsupported parameter') && normalized.includes('reasoning');
    }

    return false;
  }

  private isHttpUrlTemplate(urlTemplate: unknown): boolean {
    if (typeof urlTemplate !== 'string') {
      return false;
    }
    const normalized = urlTemplate.trim().toLowerCase();
    return normalized.startsWith('http://') || normalized.startsWith('https://');
  }
}
