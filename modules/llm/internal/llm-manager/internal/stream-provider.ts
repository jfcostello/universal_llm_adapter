import type { AxiosInstance } from 'axios';

import type {
  AdapterLogger,
  LLMCallSettings,
  Message,
  ProviderManifest,
  ToolChoice,
  UnifiedTool
} from '../../../../../kernel/index.js';
import { ProviderExecutionError } from '../../../../../kernel/index.js';

import { aggregateSystemMessages } from '../../../../messages/index.js';
import { logRequest, logResponse } from '../../../../shared/index.js';
import { buildFinalPayload } from '../../payload/payload-builder.js';

import { isHttpUrlTemplate, isRateLimitResponse } from './http-utils.js';
import { redactUnsupportedExtraValue } from './redact-unsupported-extra.js';

export async function* streamProvider(options: {
  httpClient: AxiosInstance;
  registry: any;
  provider: ProviderManifest;
  model: string;
  settings: LLMCallSettings;
  messages: Message[];
  tools: UnifiedTool[];
  toolChoice?: ToolChoice;
  providerExtras: Record<string, any>;
  logger?: AdapterLogger;
  context: any;
}): AsyncGenerator<any> {
  const normalizedMessages = aggregateSystemMessages(options.messages);
  const compat = typeof options.registry.getCompatModuleForProvider === 'function'
    ? await options.registry.getCompatModuleForProvider(options.provider.id)
    : await options.registry.getCompatModule(options.provider.compat);
  const providerRequestsHttp = isHttpUrlTemplate(
    options.provider.endpoint?.streamingUrlTemplate || options.provider.endpoint?.urlTemplate
  );

  options.logger?.info('streamProvider called', { provider: options.provider.id, model: options.model, messagesCount: options.messages.length });

  // SDK-based providers: if compat has streamSDK method, use it instead of HTTP
  if (!providerRequestsHttp && typeof compat.streamSDK === 'function') {
    if (options.logger) {
      options.logger.info('Using SDK-based streaming compat', { provider: options.provider.id, model: options.model });
    }

    // Log raw request for live tests
    if (process.env.LLM_LIVE === '1') {
      try {
        logRequest({
          url: `SDK:${options.provider.id}/${options.model}`,
          method: 'SDK_STREAM',
          headers: {},
          body: {
            __liveType: 'normalized_llm_stream_request',
            model: options.model,
            provider: options.provider.id,
            messages: normalizedMessages,
            tools: options.tools,
            toolChoice: options.toolChoice,
            settings: options.settings,
            providerExtras: options.providerExtras
          }
        }, options.context.metadata);
      } catch {
        // live-test logger not available, skip logging
      }
    }

    const streamedChunks: any[] = [];
    const shouldLogLive = process.env.LLM_LIVE === '1';

    try {
      for await (const chunk of compat.streamSDK(options.model, options.settings, normalizedMessages, options.tools, options.toolChoice, options.logger, options.provider.endpoint.headers)) {
        if (shouldLogLive) {
          streamedChunks.push(chunk);
        }
        yield chunk;
      }

      // Log the complete streamed response for live tests
      if (shouldLogLive) {
        try {
          logResponse({
            status: 200,
            statusText: 'SDK_SUCCESS',
            headers: {},
            body: { chunks: streamedChunks, totalChunks: streamedChunks.length }
          }, options.context.metadata);
        } catch {
          // live-test logger not available, skip logging
        }
      }

      return;
    } catch (error: any) {
      if (error instanceof ProviderExecutionError) {
        throw error;
      }
      throw new ProviderExecutionError(options.provider.id, error.message);
    }
  }

  // HTTP-based providers: proceed with standard HTTP streaming flow
  const { payload: finalPayload, unconsumedExtras } = buildFinalPayload({
    provider: options.provider,
    compat,
    model: options.model,
    settings: options.settings,
    messages: normalizedMessages,
    tools: options.tools,
    toolChoice: options.toolChoice,
    providerExtras: options.providerExtras,
    streaming: true
  });

  if (options.logger) {
    for (const [field, value] of Object.entries(unconsumedExtras)) {
      const redactedValue = redactUnsupportedExtraValue(field, value);
      options.logger.info('Extra field not supported by provider', {
        provider: options.provider.id,
        field,
        value: redactedValue,
        message: `Field "${field}" is not supported by ${options.provider.id} and was not sent to the API. Check provider payloadExtensions or compat module.`
      });
    }
  }

  const url = (options.provider.endpoint.streamingUrlTemplate || options.provider.endpoint.urlTemplate).replace('{model}', options.model);

  options.logger?.info('About to make streaming HTTP request', { url, messagesCount: options.messages.length });

  // Log raw request for live tests (always on when LLM_LIVE=1)
  if (process.env.LLM_LIVE === '1') {
    try {
      logRequest(
        {
          url: `NORMALIZED:${options.provider.id}/${options.model}`,
          method: 'NORMALIZED_STREAM',
          headers: {},
          body: {
            __liveType: 'normalized_llm_stream_request',
            model: options.model,
            provider: options.provider.id,
            messages: normalizedMessages,
            tools: options.tools,
            toolChoice: options.toolChoice,
            settings: options.settings,
            providerExtras: options.providerExtras
          }
        },
        options.context.metadata
      );
      logRequest({
        url,
        method: options.provider.endpoint.method,
        headers: options.provider.endpoint.headers,
        body: finalPayload
      }, options.context.metadata);
    } catch {
      // live-test logger not available, skip logging
    }
  }

  const mergedHeaders = { ...(options.provider.endpoint.headers || {}), ...(options.provider.endpoint.streamingHeaders || {}) };

  const response = await options.httpClient.request({
    method: options.provider.endpoint.method,
    url,
    headers: mergedHeaders,
    data: finalPayload,
    responseType: 'stream'
  });

  options.logger?.info('HTTP response received for streaming', { statusCode: response.status });

  // For live tests, log response headers immediately (body will be logged as chunks arrive)
  const streamedChunks: any[] = [];
  const shouldLogLive = process.env.LLM_LIVE === '1';

  // Handle error responses
  if (response.status >= 400) {
    let errorBody = '';
    for await (const chunk of response.data) {
      errorBody += chunk.toString();
    }

    options.logger?.error('Streaming request failed', {
      provider: options.provider.id,
      model: options.model,
      status: response.status,
      body: errorBody
    });

    const isRateLimit = isRateLimitResponse(options.provider, { status: response.status, data: errorBody, headers: response.headers });

    throw new ProviderExecutionError(
      options.provider.id,
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
    options.logger?.info('Received chunk from response.data', { chunkNumber: chunkCount, chunkSize: chunk.length });
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
        } catch {
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
      logResponse({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: { chunks: streamedChunks, totalChunks: streamedChunks.length }
      }, options.context.metadata);
    } catch {
      // live-test logger not available, skip logging
    }
  }
}
