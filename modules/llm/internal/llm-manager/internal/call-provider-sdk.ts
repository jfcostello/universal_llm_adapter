import type {
  AdapterLogger,
  LLMCallSettings,
  LLMResponse,
  Message,
  ProviderManifest,
  ToolCall,
  ToolChoice,
  UnifiedTool,
  RunContext
} from '../../../../../kernel/index.js';
import { ProviderExecutionError } from '../../../../../kernel/index.js';

import { logRequest, logResponse, monotonicElapsedMs } from '../../../../shared/index.js';

import { normalizeToolCallsIfPresent } from './normalize-tool-calls.js';
import { recordObservabilityRequest, recordObservabilityResponse, logLiveObservabilityEvent } from './observability.js';
import { attachUsageCostForResponseIfNeeded } from './attach-usage-cost.js';
import { redactUnsupportedExtraValue } from './redact-unsupported-extra.js';

export async function callProviderViaSdk(options: {
  compat: any;
  provider: ProviderManifest;
  model: string;
  settings: LLMCallSettings;
  normalizedMessages: Message[];
  tools: UnifiedTool[];
  toolChoice?: ToolChoice;
  providerExtras: Record<string, any>;
  logger?: AdapterLogger;
  context: RunContext;
  generationId: string | undefined;
  requestTimestampMs: number;
  startTimeMonoNs: bigint;
  shouldLogLive: boolean;
}): Promise<LLMResponse> {
  const shouldLogLive = options.shouldLogLive;

  if (options.logger) {
    options.logger.info('Using SDK-based compat', { provider: options.provider.id, model: options.model });

    // Log warnings for unconsumed provider extras (SDK methods don't consume them)
    for (const [field, value] of Object.entries(options.providerExtras)) {
      const redactedValue = redactUnsupportedExtraValue(field, value);
      // Log to both AdapterLogger and console.error (for live test detection)
      const msg = `Extra field not supported by provider: "${field}" is not supported by ${options.provider.id} and was not sent to the API`;
      options.logger.info(msg, {
        provider: options.provider.id,
        field,
        value: redactedValue
      });
      // Log to stderr for live test expectations
      if (shouldLogLive) {
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'info',
          message: msg,
          data: { provider: options.provider.id, field, value: redactedValue }
        }));
      }
    }

    // Log SDK request using existing logging infrastructure
    options.logger.logLLMRequest({
      url: `SDK:${options.provider.id}/${options.model}`,
      method: 'SDK_CALL',
      headers: {},
      body: { model: options.model, messages: options.normalizedMessages, tools: options.tools, toolChoice: options.toolChoice, settings: options.settings, providerExtras: options.providerExtras }
    });
  }

  // Log raw request for live tests
  if (shouldLogLive) {
    try {
      logRequest({
        url: `SDK:${options.provider.id}/${options.model}`,
        method: 'SDK_CALL',
        headers: {},
        body: {
          __liveType: 'normalized_llm_request',
          model: options.model,
          provider: options.provider.id,
          messages: options.normalizedMessages,
          tools: options.tools,
          toolChoice: options.toolChoice,
          settings: options.settings,
          providerExtras: options.providerExtras
        }
      }, options.context.metadata);
    } catch {
      // Live logger not available, skip
    }
  }

  try {
    const sdkRequestPayload = { model: options.model, messages: options.normalizedMessages, tools: options.tools, toolChoice: options.toolChoice, settings: options.settings, providerExtras: options.providerExtras };
    const response = await options.compat.callSDK(options.model, options.settings, options.normalizedMessages, options.tools, options.toolChoice, options.logger, options.provider.endpoint.headers);
    response.toolCalls = await normalizeToolCallsIfPresent(response.toolCalls);
    response.provider = options.provider.id;

    await attachUsageCostForResponseIfNeeded({
      usage: response.usage,
      settings: options.settings,
      provider: options.provider.id,
      model: options.model
    });

    // Log SDK response using existing logging infrastructure
    if (options.logger) {
      const duration = monotonicElapsedMs(options.startTimeMonoNs);
      options.logger.logLLMResponse({
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
        logResponse({
          status: 200,
          statusText: 'SDK_SUCCESS',
          headers: {},
          body: response
        }, options.context.metadata);
      } catch {
        // Live logger not available, skip
      }
    }

    const requestEvent = recordObservabilityRequest(
      options.context,
      options.provider.id,
      options.model,
      options.generationId,
      options.requestTimestampMs,
      options.normalizedMessages,
      options.tools,
      options.settings,
      sdkRequestPayload,
      options.logger
    );
    if (shouldLogLive && requestEvent) {
      await logLiveObservabilityEvent(options.context, {
        eventType: 'LLM_REQUEST',
        traceId: requestEvent.traceId,
        generationId: requestEvent.generationId,
        event: requestEvent
      });
    }

    // Record successful response to observability
    const responseEvent = recordObservabilityResponse(
      options.context,
      options.provider.id,
      options.model,
      options.generationId,
      options.startTimeMonoNs,
      response,
      response.raw,
      undefined,
      options.logger
    );
    if (shouldLogLive && responseEvent) {
      await logLiveObservabilityEvent(options.context, {
        eventType: 'LLM_RESPONSE',
        traceId: responseEvent.traceId,
        generationId: responseEvent.generationId,
        event: responseEvent
      });
    }

    return response;
  } catch (error: any) {
    const sdkRequestPayload = { model: options.model, messages: options.normalizedMessages, tools: options.tools, toolChoice: options.toolChoice, settings: options.settings, providerExtras: options.providerExtras };
    const requestEvent = recordObservabilityRequest(
      options.context,
      options.provider.id,
      options.model,
      options.generationId,
      options.requestTimestampMs,
      options.normalizedMessages,
      options.tools,
      options.settings,
      sdkRequestPayload,
      options.logger
    );
    if (shouldLogLive && requestEvent) {
      await logLiveObservabilityEvent(options.context, {
        eventType: 'LLM_REQUEST',
        traceId: requestEvent.traceId,
        generationId: requestEvent.generationId,
        event: requestEvent
      });
    }

    // Record error response to observability
    const responseEvent = recordObservabilityResponse(
      options.context,
      options.provider.id,
      options.model,
      options.generationId,
      options.startTimeMonoNs,
      undefined,
      undefined,
      { message: error.message, retryable: error instanceof ProviderExecutionError ? error.isRateLimit : false },
      options.logger
    );
    if (shouldLogLive && responseEvent) {
      await logLiveObservabilityEvent(options.context, {
        eventType: 'LLM_RESPONSE',
        traceId: responseEvent.traceId,
        generationId: responseEvent.generationId,
        event: responseEvent
      });
    }

    if (error instanceof ProviderExecutionError) {
      throw error;
    }
    throw new ProviderExecutionError(options.provider.id, error.message);
  }
}
