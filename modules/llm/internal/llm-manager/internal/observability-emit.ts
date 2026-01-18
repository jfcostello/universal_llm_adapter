import type { LLMCallSettings, LLMResponse, Message, UnifiedTool, AdapterLogger, RunContext } from '../../../../../kernel/index.js';

import { logLiveObservabilityEvent, recordObservabilityRequest, recordObservabilityResponse } from './observability.js';

export async function emitObservabilityRequest(options: {
  context: RunContext;
  provider: string;
  model: string;
  generationId: string | undefined;
  timestampMs: number;
  messages: Message[];
  tools: UnifiedTool[];
  settings: LLMCallSettings;
  requestPayload: unknown;
  logger?: AdapterLogger;
  shouldLogLive: boolean;
}): Promise<Record<string, any> | null> {
  const requestEvent = recordObservabilityRequest(
    options.context,
    options.provider,
    options.model,
    options.generationId,
    options.timestampMs,
    options.messages,
    options.tools,
    options.settings,
    options.requestPayload,
    options.logger
  );
  if (options.shouldLogLive && requestEvent) {
    await logLiveObservabilityEvent(options.context, {
      eventType: 'LLM_REQUEST',
      traceId: requestEvent.traceId,
      generationId: requestEvent.generationId,
      event: requestEvent
    });
  }
  return requestEvent;
}

export async function emitObservabilityResponse(options: {
  context: RunContext;
  provider: string;
  model: string;
  generationId: string | undefined;
  startTimeMonoNs: bigint;
  response?: LLMResponse;
  rawResponse?: unknown;
  error?: { message: string; code?: string; retryable?: boolean };
  logger?: AdapterLogger;
  shouldLogLive: boolean;
}): Promise<Record<string, any> | null> {
  const responseEvent = recordObservabilityResponse(
    options.context,
    options.provider,
    options.model,
    options.generationId,
    options.startTimeMonoNs,
    options.response,
    options.rawResponse,
    options.error,
    options.logger
  );
  if (options.shouldLogLive && responseEvent) {
    await logLiveObservabilityEvent(options.context, {
      eventType: 'LLM_RESPONSE',
      traceId: responseEvent.traceId,
      generationId: responseEvent.generationId,
      event: responseEvent
    });
  }
  return responseEvent;
}
