import type { AxiosInstance } from 'axios';

import type {
  AdapterLogger,
  LLMCallSettings,
  LLMResponse,
  Message,
  ProviderManifest,
  ToolChoice,
  UnifiedTool,
  RunContext
} from '../../../../../kernel/index.js';
import { ProviderExecutionError } from '../../../../../kernel/index.js';

import {
  deriveObservabilityModel,
  logRequest,
  logResponse,
  monotonicElapsedMs
} from '../../../../shared/index.js';

import { buildFinalPayload } from '../../payload/payload-builder.js';
import { normalizeToolCallsIfPresent } from './normalize-tool-calls.js';
import { emitObservabilityRequest, emitObservabilityResponse } from './observability-emit.js';
import {
  isRateLimitResponse,
  isReasoningDisabledNotAllowedError,
  isReasoningExplicitlyDisabled,
  isUnsupportedReasoningParamError,
  stripReasoning
} from './http-utils.js';
import { redactUnsupportedExtraValue } from './redact-unsupported-extra.js';

export async function callProviderViaHttp(options: {
  httpClient: AxiosInstance;
  reasoningUnsupportedByProviderModel: Set<string>;
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
  compat: any;
}): Promise<LLMResponse> {
  const cacheKey = `${options.provider.id}:${options.model}`;
  const { payload: rawPayload, unconsumedExtras } = buildFinalPayload({
    provider: options.provider,
    compat: options.compat,
    model: options.model,
    settings: options.settings,
    messages: options.normalizedMessages,
    tools: options.tools,
    toolChoice: options.toolChoice,
    providerExtras: options.providerExtras
  });
  const shouldStripReasoning =
    !options.shouldLogLive && options.reasoningUnsupportedByProviderModel.has(cacheKey);
  const finalPayload = shouldStripReasoning ? stripReasoning(rawPayload) : rawPayload;

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

  // Build request
  const url = options.provider.endpoint.urlTemplate.replace('{model}', options.model);

  let lastRequestPayload: any = undefined;
  let lastRawResponse: any = undefined;

  try {
    lastRequestPayload = finalPayload;

    const sendRequest = async (payload: any) => {
      lastRequestPayload = payload;
      // Log beautiful formatted LLM request to dedicated log file
      if (options.logger) {
        options.logger.logLLMRequest({
          url,
          method: options.provider.endpoint.method,
          headers: options.provider.endpoint.headers,
          body: payload
        });
      }

      // Log raw request for live tests (always on when LLM_LIVE=1)
      if (options.shouldLogLive) {
        try {
          logRequest(
            {
              url: `NORMALIZED:${options.provider.id}/${options.model}`,
              method: 'NORMALIZED_CALL',
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
            },
            options.context.metadata
          );
          logRequest(
            {
              url,
              method: options.provider.endpoint.method,
              headers: options.provider.endpoint.headers,
              body: payload
            },
            options.context.metadata
          );
        } catch {
          // Live logger not available, skip
        }
      }

      return options.httpClient.request({
        method: options.provider.endpoint.method,
        url,
        headers: options.provider.endpoint.headers,
        data: payload
      });
    };

    let response = await sendRequest(finalPayload);
    lastRawResponse = response.data;

    // Log beautiful formatted LLM response to dedicated log file
    if (options.logger) {
      const duration = monotonicElapsedMs(options.startTimeMonoNs);
      options.logger.logLLMResponse({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: response.data,
        duration
      });
    }

    // Log raw response for live tests (always on when LLM_LIVE=1)
    if (options.shouldLogLive) {
      try {
        logResponse({
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: response.data
        }, options.context.metadata);
      } catch {
        // Live logger not available, skip
      }
    }

    if (response.status >= 400) {
      // Retry once without reasoning if the provider rejects reasoning parameters.
      // This keeps runs resilient when optional features are requested but unsupported by the target model.
      if (isUnsupportedReasoningParamError(response.data) && finalPayload?.reasoning !== undefined) {
        options.reasoningUnsupportedByProviderModel.add(cacheKey);

        options.logger?.warning('Provider rejected reasoning parameters; retrying without reasoning', {
          provider: options.provider.id,
          model: options.model
        });

        const retryPayload = stripReasoning(finalPayload);
        response = await sendRequest(retryPayload);
        lastRawResponse = response.data;

        // Log response for retry attempt
        if (options.logger) {
          const duration = monotonicElapsedMs(options.startTimeMonoNs);
          options.logger.logLLMResponse({
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.data,
            duration
          });
        }

        if (options.shouldLogLive) {
          try {
            logResponse(
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.data
              },
              options.context.metadata
            );
          } catch {
            // Live logger not available, skip
          }
        }
      }

      // Some providers require reasoning for certain endpoints and reject explicit attempts to disable it.
      // When this happens, retry once with reasoning removed so the call can proceed.
      if (
        response.status >= 400 &&
        finalPayload?.reasoning !== undefined &&
        isReasoningExplicitlyDisabled(finalPayload) &&
        isReasoningDisabledNotAllowedError(response.data)
      ) {
        options.logger?.warning('Provider rejected explicit reasoning disable; retrying without reasoning', {
          provider: options.provider.id,
          model: options.model
        });

        const retryPayload = stripReasoning(finalPayload);
        response = await sendRequest(retryPayload);
        lastRawResponse = response.data;

        if (options.logger) {
          const duration = monotonicElapsedMs(options.startTimeMonoNs);
          options.logger.logLLMResponse({
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.data,
            duration
          });
        }

        if (options.shouldLogLive) {
          try {
            logResponse(
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.data
              },
              options.context.metadata
            );
          } catch {
            // Live logger not available, skip
          }
        }
      }

      if (response.status >= 400) {
        const isRateLimit = isRateLimitResponse(options.provider, response);

        if (options.logger) {
          options.logger.error('Provider call failed', {
            provider: options.provider.id,
            model: options.model,
            status: response.status,
            isRateLimit
          });
        }

        // Record HTTP error response to observability
        const observabilityModel = deriveObservabilityModel({
          provider: options.provider.id,
          model: options.model,
          providerHint: lastRawResponse
        });

        await emitObservabilityRequest({
          context: options.context,
          provider: options.provider.id,
          model: observabilityModel,
          generationId: options.generationId,
          timestampMs: options.requestTimestampMs,
          messages: options.normalizedMessages,
          tools: options.tools,
          settings: options.settings,
          requestPayload: lastRequestPayload,
          logger: options.logger,
          shouldLogLive: options.shouldLogLive
        });

        await emitObservabilityResponse({
          context: options.context,
          provider: options.provider.id,
          model: observabilityModel,
          generationId: options.generationId,
          startTimeMonoNs: options.startTimeMonoNs,
          response: undefined,
          rawResponse: lastRawResponse,
          error: { message: JSON.stringify(response.data), code: String(response.status), retryable: isRateLimit },
          logger: options.logger,
          shouldLogLive: options.shouldLogLive
        });

        throw new ProviderExecutionError(
          options.provider.id,
          JSON.stringify(response.data),
          response.status,
          isRateLimit
        );
      }
    }

    const parsed = options.compat.parseResponse(response.data, options.model);
    parsed.toolCalls = await normalizeToolCallsIfPresent(parsed.toolCalls);
    parsed.provider = options.provider.id;

    const observabilityModel = deriveObservabilityModel({
      provider: options.provider.id,
      model: options.model,
      providerHint: lastRawResponse
    });

    await emitObservabilityRequest({
      context: options.context,
      provider: options.provider.id,
      model: observabilityModel,
      generationId: options.generationId,
      timestampMs: options.requestTimestampMs,
      messages: options.normalizedMessages,
      tools: options.tools,
      settings: options.settings,
      requestPayload: lastRequestPayload,
      logger: options.logger,
      shouldLogLive: options.shouldLogLive
    });

    // Record successful HTTP response to observability
    await emitObservabilityResponse({
      context: options.context,
      provider: options.provider.id,
      model: observabilityModel,
      generationId: options.generationId,
      startTimeMonoNs: options.startTimeMonoNs,
      response: parsed,
      rawResponse: lastRawResponse,
      error: undefined,
      logger: options.logger,
      shouldLogLive: options.shouldLogLive
    });

    return parsed;
  } catch (error: any) {
    // Record error response to observability (only for errors not already recorded)
    if (!(error instanceof ProviderExecutionError && error.statusCode !== undefined)) {
      const observabilityModel = deriveObservabilityModel({
        provider: options.provider.id,
        model: options.model,
        providerHint: lastRawResponse
      });

      await emitObservabilityRequest({
        context: options.context,
        provider: options.provider.id,
        model: observabilityModel,
        generationId: options.generationId,
        timestampMs: options.requestTimestampMs,
        messages: options.normalizedMessages,
        tools: options.tools,
        settings: options.settings,
        requestPayload: lastRequestPayload,
        logger: options.logger,
        shouldLogLive: options.shouldLogLive
      });

      await emitObservabilityResponse({
        context: options.context,
        provider: options.provider.id,
        model: observabilityModel,
        generationId: options.generationId,
        startTimeMonoNs: options.startTimeMonoNs,
        response: undefined,
        rawResponse: lastRawResponse,
        error: { message: error.message, retryable: false },
        logger: options.logger,
        shouldLogLive: options.shouldLogLive
      });
    }

    if (error instanceof ProviderExecutionError) {
      throw error;
    }
    throw new ProviderExecutionError(options.provider.id, error.message);
  }
}
