import type {
  LLMCallSettings,
  LLMResponse,
  Message,
  ToolCall,
  UnifiedTool,
  AdapterLogger,
  RunContext
} from '../../../../../kernel/index.js';

import { redactJsonCredentials } from '../../../../security/index.js';
import {
  filterContentForObservability,
  filterMessagesForObservability,
  logObservabilityEvent,
  monotonicElapsedMs,
  normalizeParentGenerationId
} from '../../../../shared/index.js';

/**
 * Record an LLM request event to observability.
 * Never throws - errors are logged and swallowed.
 */
export function recordObservabilityRequest(
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
    const normalizedParentGenerationId = normalizeParentGenerationId(
      context.parentGenerationId,
      generationId
    );

    const event = {
      traceId: context.observability.traceId,
      generationId,
      ...(normalizedParentGenerationId ? { parentGenerationId: normalizedParentGenerationId } : {}),
      timestampMs,
      provider,
      model,
      messages: filterMessagesForObservability(messages, captureMessages),
      sessionId: context.observability.sessionId,
      metadata: context.observability.metadata,
      tools: redactJsonCredentials(tools) as any,
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
export function recordObservabilityResponse(
  context: RunContext,
  provider: string,
  model: string,
  generationId: string | undefined,
  startTimeMonoNs: bigint,
  response?: LLMResponse,
  rawResponse?: unknown,
  error?: { message: string; code?: string; retryable?: boolean },
  logger?: AdapterLogger
): Record<string, any> | null {
  if (!context.observability) return null;

  try {
    const captureMessages = context.observability.captureMessages ?? 'full';
    const captureToolArgs = context.observability.captureToolArgs ?? false;
    const captureRawResponse = context.observability.captureRawResponse ?? true;
    const normalizedParentGenerationId = normalizeParentGenerationId(
      context.parentGenerationId,
      generationId
    );

    const endTimeMs = Date.now();
    const durationMs = monotonicElapsedMs(startTimeMonoNs);
    const promptTokens = response?.usage?.promptTokens ?? undefined;
    const completionTokens = response?.usage?.completionTokens ?? undefined;
    const totalTokens = response?.usage?.totalTokens ?? undefined;
    const toolCallsForObservability: ToolCall[] | undefined = (() => {
      const fromResponse = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
      if (fromResponse.length > 0) return fromResponse;
      const fromContext = Array.isArray((context as any).toolCallsSoFar) ? (context as any).toolCallsSoFar : [];
      return fromContext.length > 0 ? fromContext : undefined;
    })();
    const event = {
      traceId: context.observability.traceId,
      generationId,
      ...(normalizedParentGenerationId ? { parentGenerationId: normalizedParentGenerationId } : {}),
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

export async function logLiveObservabilityEvent(
  context: RunContext,
  payload: {
    eventType: 'LLM_REQUEST' | 'LLM_RESPONSE';
    traceId?: string;
    generationId?: string;
    event: unknown;
  }
): Promise<void> {
  try {
    logObservabilityEvent(payload as any, context.metadata);
  } catch {
    // ignore
  }
}
