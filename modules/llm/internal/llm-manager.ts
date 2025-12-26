import axios, { AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';
import type {
  ProviderManifest,
  LLMCallSettings,
  Message,
  UnifiedTool,
  ToolCall,
  ToolChoice,
  LLMResponse,
  AdapterLogger,
  RunContext
} from '../../kernel/index.js';
import { ProviderExecutionError, getDefaults } from '../../kernel/index.js';
import { aggregateSystemMessages } from '../../messages/index.js';
import { redactJsonCredentials } from '../../security/index.js';
import { buildFinalPayload } from './payload/payload-builder.js';
import { filterContentForObservability, filterMessagesForObservability } from './observability-capture.js';

export class LLMManager {
  private httpClient: AxiosInstance;
  private reasoningUnsupportedByProviderModel = new Set<string>();

  constructor(private registry: any) {
    this.httpClient = axios.create({
      timeout: getDefaults().timeouts.llmHttp,
      validateStatus: () => true // Handle all status codes
    });
  }

  /**
   * Record an LLM request event to observability.
   * Never throws - errors are logged and swallowed.
   */
  private recordObservabilityRequest(
    context: RunContext,
    provider: string,
    model: string,
    generationId: string | undefined,
    timestampMs: number,
    messages: Message[],
    tools: UnifiedTool[],
    settings: LLMCallSettings,
    requestPayload: unknown,
    logger?: AdapterLogger
  ): Record<string, any> | null {
    if (!context.observability) return null;

    try {
      const captureMessages = context.observability.captureMessages ?? 'full';
      const captureRequestPayload = context.observability.captureRequestPayload ?? true;

      const event = {
        traceId: context.observability.traceId,
        generationId,
        timestampMs,
        provider,
        model,
        messages: filterMessagesForObservability(messages, captureMessages),
        sessionId: context.observability.sessionId,
        metadata: context.observability.metadata,
        tools: tools.map(t => ({ name: t.name, description: t.description })),
        settings,
        ...(captureRequestPayload ? { requestPayload: redactJsonCredentials(requestPayload) } : {})
      };

      context.observability.exporter.recordLLMRequest(event as any);
      return event;
    } catch (e) {
      // Observability must never throw - log and continue
      logger?.warning('Failed to record observability request event', { error: (e as Error).message });
      return null;
    }
  }

  /**
   * Record an LLM response event to observability.
   * Never throws - errors are logged and swallowed.
   */
  private recordObservabilityResponse(
    context: RunContext,
    provider: string,
    model: string,
    generationId: string | undefined,
    startTime: number,
    response?: LLMResponse,
    rawResponse?: unknown,
    error?: { message: string; code?: string; retryable?: boolean },
    logger?: AdapterLogger
  ): Record<string, any> | null {
    if (!context.observability) return null;

    try {
      const captureMessages = context.observability.captureMessages ?? 'full';
      const captureToolArgs = context.observability.captureToolArgs ?? true;
      const captureRawResponse = context.observability.captureRawResponse ?? true;

      const endTimeMs = Date.now();
      const durationMs = endTimeMs - startTime;
      const promptTokens = response?.usage?.promptTokens ?? undefined;
      const completionTokens = response?.usage?.completionTokens ?? undefined;
      const totalTokens = response?.usage?.totalTokens ?? undefined;
      const toolCallsForObservability: ToolCall[] | undefined = (() => {
        const fromResponse = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
        if (fromResponse.length > 0) return fromResponse;
        const fromContext = Array.isArray(context.toolCallsSoFar) ? context.toolCallsSoFar : [];
        return fromContext.length > 0 ? fromContext : undefined;
      })();
      const event = {
        traceId: context.observability.traceId,
        generationId,
        sessionId: context.observability.sessionId,
        timestampMs: endTimeMs,
        provider,
        model,
        content: filterContentForObservability(response?.content || [], captureMessages),
        ...(captureRawResponse && rawResponse !== undefined ? { rawResponse: redactJsonCredentials(rawResponse) } : {}),
        metadata: context.observability.metadata,
        usage: response?.usage ? {
          promptTokens,
          completionTokens,
          totalTokens: totalTokens ?? (
            typeof promptTokens === 'number' || typeof completionTokens === 'number'
              ? (promptTokens || 0) + (completionTokens || 0)
              : undefined
          ),
          cachedTokens: response.usage.cachedTokens ?? undefined,
          reasoningTokens: response.usage.reasoningTokens ?? undefined,
          audioTokens: response.usage.audioTokens ?? undefined,
          cost: response.usage.cost ?? undefined
        } : undefined,
        toolCalls: toolCallsForObservability?.map(tc => {
          const args = tc.arguments ?? tc.args;
          const metadata = tc.metadata;
          const base = { id: tc.id, name: tc.name };
          if (!captureToolArgs) return base;
          return {
            ...base,
            ...(args !== undefined ? { arguments: redactJsonCredentials(args) } : {}),
            ...(metadata !== undefined ? { metadata: redactJsonCredentials(metadata) } : {})
          };
        }),
        durationMs,
        error
      };

      context.observability.exporter.recordLLMResponse(event as any);
      return event;
    } catch (e) {
      // Observability must never throw - log and continue
      logger?.warning('Failed to record observability response event', { error: (e as Error).message });
      return null;
    }
  }

  private async logLiveObservabilityEvent(
    context: RunContext,
    payload: {
      eventType: 'LLM_REQUEST' | 'LLM_RESPONSE';
      traceId?: string;
      generationId?: string;
      event: unknown;
    }
  ): Promise<void> {
    try {
      const { logObservabilityEvent } = await import('./live-test-logger.js');
      logObservabilityEvent(payload as any, context.metadata);
    } catch {
      // ignore
    }
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
    context: RunContext = {}
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    const generationId = context.observability ? randomUUID() : undefined;
    const requestTimestampMs = startTime;
    const normalizedMessages = aggregateSystemMessages(messages);
    const shouldLogLive = process.env.LLM_LIVE === '1';
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
          if (shouldLogLive) {
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
      if (shouldLogLive) {
        try {
          const { logRequest } = await import('./live-test-logger.js');
          logRequest({
            url: `SDK:${provider.id}/${model}`,
            method: 'SDK_CALL',
            headers: {},
            body: { model, messages: normalizedMessages, tools, toolChoice, settings, providerExtras }
          }, context.metadata);
        } catch (e) {
          // Live logger not available, skip
        }
      }

      try {
        const sdkRequestPayload = { model, messages: normalizedMessages, tools, toolChoice, settings, providerExtras };
        const response = await compat.callSDK(model, settings, normalizedMessages, tools, toolChoice, logger, provider.endpoint.headers);
        response.toolCalls = await this.normalizeToolCallsIfPresent(response.toolCalls);
        response.provider = provider.id;

        // Log SDK response using existing logging infrastructure
        if (logger) {
          const duration = Date.now() - startTime;
          logger.logLLMResponse({
            status: 200,
            statusText: 'SDK_SUCCESS',
            headers: {},
            body: response,
            duration
          });
        }

        // Log raw response for live tests
        if (shouldLogLive) {
          try {
            const { logResponse } = await import('./live-test-logger.js');
            logResponse({
              status: 200,
              statusText: 'SDK_SUCCESS',
              headers: {},
              body: response
            }, context.metadata);
          } catch (e) {
            // Live logger not available, skip
          }
        }

        const requestEvent = this.recordObservabilityRequest(
          context,
          provider.id,
          model,
          generationId,
          requestTimestampMs,
          normalizedMessages,
          tools,
          settings,
          sdkRequestPayload,
          logger
        );
        if (shouldLogLive && requestEvent) {
          await this.logLiveObservabilityEvent(context, {
            eventType: 'LLM_REQUEST',
            traceId: requestEvent.traceId,
            generationId: requestEvent.generationId,
            event: requestEvent
          });
        }

        // Record successful response to observability
        const responseEvent = this.recordObservabilityResponse(
          context,
          provider.id,
          model,
          generationId,
          startTime,
          response,
          response.raw,
          undefined,
          logger
        );
        if (shouldLogLive && responseEvent) {
          await this.logLiveObservabilityEvent(context, {
            eventType: 'LLM_RESPONSE',
            traceId: responseEvent.traceId,
            generationId: responseEvent.generationId,
            event: responseEvent
          });
        }

        return response;
      } catch (error: any) {
        const sdkRequestPayload = { model, messages: normalizedMessages, tools, toolChoice, settings, providerExtras };
        const requestEvent = this.recordObservabilityRequest(
          context,
          provider.id,
          model,
          generationId,
          requestTimestampMs,
          normalizedMessages,
          tools,
          settings,
          sdkRequestPayload,
          logger
        );
        if (shouldLogLive && requestEvent) {
          await this.logLiveObservabilityEvent(context, {
            eventType: 'LLM_REQUEST',
            traceId: requestEvent.traceId,
            generationId: requestEvent.generationId,
            event: requestEvent
          });
        }

        // Record error response to observability
        const responseEvent = this.recordObservabilityResponse(
          context,
          provider.id,
          model,
          generationId,
          startTime,
          undefined,
          undefined,
          { message: error.message, retryable: error instanceof ProviderExecutionError ? error.isRateLimit : false },
          logger
        );
        if (shouldLogLive && responseEvent) {
          await this.logLiveObservabilityEvent(context, {
            eventType: 'LLM_RESPONSE',
            traceId: responseEvent.traceId,
            generationId: responseEvent.generationId,
            event: responseEvent
          });
        }

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
      !shouldLogLive && this.reasoningUnsupportedByProviderModel.has(cacheKey);
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

    let lastRequestPayload: any = undefined;
    let lastRawResponse: any = undefined;

    try {
      lastRequestPayload = finalPayload;

      const sendRequest = async (payload: any) => {
        lastRequestPayload = payload;
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
        if (shouldLogLive) {
          try {
            const { logRequest } = await import('./live-test-logger.js');
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
            // Live logger not available, skip
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
      lastRawResponse = response.data;

      // Log beautiful formatted LLM response to dedicated log file
      if (logger) {
        const duration = Date.now() - startTime;
        logger.logLLMResponse({
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: response.data,
          duration
        });
      }

      // Log raw response for live tests (always on when LLM_LIVE=1)
      if (shouldLogLive) {
        try {
          const { logResponse } = await import('./live-test-logger.js');
          logResponse({
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.data
          }, context.metadata);
        } catch (e) {
          // Live logger not available, skip
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
          lastRawResponse = response.data;

          // Log response for retry attempt
          if (logger) {
            const duration = Date.now() - startTime;
            logger.logLLMResponse({
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              body: response.data,
              duration
            });
          }

          if (shouldLogLive) {
            try {
              const { logResponse } = await import('./live-test-logger.js');
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
              // Live logger not available, skip
            }
          }
        }

        // Some providers require reasoning for certain endpoints and reject explicit attempts to disable it.
        // When this happens, retry once with reasoning removed so the call can proceed.
        if (
          response.status >= 400 &&
          finalPayload?.reasoning !== undefined &&
          this.isReasoningExplicitlyDisabled(finalPayload) &&
          this.isReasoningDisabledNotAllowedError(response.data)
        ) {
          logger?.warning('Provider rejected explicit reasoning disable; retrying without reasoning', {
            provider: provider.id,
            model
          });

          const retryPayload = this.stripReasoning(finalPayload);
          response = await sendRequest(retryPayload);
          lastRawResponse = response.data;

          if (logger) {
            const duration = Date.now() - startTime;
            logger.logLLMResponse({
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              body: response.data,
              duration
            });
          }

          if (shouldLogLive) {
            try {
              const { logResponse } = await import('./live-test-logger.js');
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
              // Live logger not available, skip
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

          // Record HTTP error response to observability
          const requestEvent = this.recordObservabilityRequest(
            context,
            provider.id,
            model,
            generationId,
            requestTimestampMs,
            normalizedMessages,
            tools,
            settings,
            lastRequestPayload,
            logger
          );
          if (shouldLogLive && requestEvent) {
            await this.logLiveObservabilityEvent(context, {
              eventType: 'LLM_REQUEST',
              traceId: requestEvent.traceId,
              generationId: requestEvent.generationId,
              event: requestEvent
            });
          }

          const responseEvent = this.recordObservabilityResponse(
            context,
            provider.id,
            model,
            generationId,
            startTime,
            undefined,
            lastRawResponse,
            { message: JSON.stringify(response.data), code: String(response.status), retryable: isRateLimit },
            logger
          );
          if (shouldLogLive && responseEvent) {
            await this.logLiveObservabilityEvent(context, {
              eventType: 'LLM_RESPONSE',
              traceId: responseEvent.traceId,
              generationId: responseEvent.generationId,
              event: responseEvent
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

      const requestEvent = this.recordObservabilityRequest(
        context,
        provider.id,
        model,
        generationId,
        requestTimestampMs,
        normalizedMessages,
        tools,
        settings,
        lastRequestPayload,
        logger
      );
      if (shouldLogLive && requestEvent) {
        await this.logLiveObservabilityEvent(context, {
          eventType: 'LLM_REQUEST',
          traceId: requestEvent.traceId,
          generationId: requestEvent.generationId,
          event: requestEvent
        });
      }

      // Record successful HTTP response to observability
      const responseEvent = this.recordObservabilityResponse(
        context,
        provider.id,
        model,
        generationId,
        startTime,
        parsed,
        lastRawResponse,
        undefined,
        logger
      );
      if (shouldLogLive && responseEvent) {
        await this.logLiveObservabilityEvent(context, {
          eventType: 'LLM_RESPONSE',
          traceId: responseEvent.traceId,
          generationId: responseEvent.generationId,
          event: responseEvent
        });
      }

      return parsed;

    } catch (error: any) {
      // Record error response to observability (only for errors not already recorded)
      if (!(error instanceof ProviderExecutionError && error.statusCode !== undefined)) {
        const requestEvent = this.recordObservabilityRequest(
          context,
          provider.id,
          model,
          generationId,
          requestTimestampMs,
          normalizedMessages,
          tools,
          settings,
          lastRequestPayload,
          logger
        );
        if (shouldLogLive && requestEvent) {
          await this.logLiveObservabilityEvent(context, {
            eventType: 'LLM_REQUEST',
            traceId: requestEvent.traceId,
            generationId: requestEvent.generationId,
            event: requestEvent
          });
        }

        const responseEvent = this.recordObservabilityResponse(
          context,
          provider.id,
          model,
          generationId,
          startTime,
          undefined,
          lastRawResponse,
          { message: error.message, retryable: false },
          logger
        );
        if (shouldLogLive && responseEvent) {
          await this.logLiveObservabilityEvent(context, {
            eventType: 'LLM_RESPONSE',
            traceId: responseEvent.traceId,
            generationId: responseEvent.generationId,
            event: responseEvent
          });
        }
      }

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
          const { logRequest } = await import('./live-test-logger.js');
          logRequest({
            url: `SDK:${provider.id}/${model}`,
            method: 'SDK_STREAM',
            headers: {},
            body: { model, messages: normalizedMessages, tools, toolChoice, settings, providerExtras }
          }, context.metadata);
        } catch (e) {
          // live-test logger not available, skip logging
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
            const { logResponse } = await import('./live-test-logger.js');
            logResponse({
              status: 200,
              statusText: 'SDK_SUCCESS',
              headers: {},
              body: { chunks: streamedChunks, totalChunks: streamedChunks.length }
            }, context.metadata);
          } catch (e) {
            // live-test logger not available, skip logging
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
        const { logRequest } = await import('./live-test-logger.js');
        logRequest({
          url,
          method: provider.endpoint.method,
          headers: provider.endpoint.headers,
          body: finalPayload
        }, context.metadata);
      } catch (e) {
        // live-test logger not available, skip logging
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
    let pendingData = '';

    for await (const chunk of response.data) {
      chunkCount++;
      logger?.info('Received chunk from response.data', { chunkNumber: chunkCount, chunkSize: chunk.length });
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          // SSE event boundary; drop any partial data accumulation.
          pendingData = '';
          continue;
        }

        // SSE comments / keepalive lines
        if (trimmed.startsWith(':')) {
          continue;
        }

        if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trimStart();
          if (data === '[DONE]') {
            pendingData = '';
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            if (shouldLogLive) {
              streamedChunks.push(parsed);
            }
            pendingData = '';
            yield parsed;
          } catch (e) {
            // Try to recover from JSON split across multiple data lines.
            if (pendingData) {
              const combined = `${pendingData}\n${data}`;
              try {
                const parsed = JSON.parse(combined);
                if (shouldLogLive) {
                  streamedChunks.push(parsed);
                }
                pendingData = '';
                yield parsed;
                continue;
              } catch {
                // Fall through and continue accumulating.
              }
            }

            // Keep any partial payload, but avoid unbounded growth.
            pendingData = pendingData ? `${pendingData}\n${data}` : data;
            if (pendingData.length > 1024 * 1024) {
              pendingData = '';
            }
          }
        }
      }
    }

    // Log the complete streamed response for live tests
    if (shouldLogLive) {
      try {
        const { logResponse } = await import('./live-test-logger.js');
        logResponse({
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: { chunks: streamedChunks, totalChunks: streamedChunks.length }
        }, context.metadata);
      } catch (e) {
        // live-test logger not available, skip logging
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

  private isReasoningExplicitlyDisabled(payload: any): boolean {
    const reasoning = payload?.reasoning;
    if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) {
      return false;
    }
    return reasoning.enabled === false || reasoning.exclude === true;
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

  private isReasoningDisabledNotAllowedError(data: any): boolean {
    const message = data?.error?.message;
    if (typeof message !== 'string') {
      return false;
    }
    const normalized = message.toLowerCase();
    return normalized.includes('reasoning') && normalized.includes('cannot be disabled');
  }

  private isHttpUrlTemplate(urlTemplate: unknown): boolean {
    if (typeof urlTemplate !== 'string') {
      return false;
    }
    const normalized = urlTemplate.trim().toLowerCase();
    return normalized.startsWith('http://') || normalized.startsWith('https://');
  }
}
