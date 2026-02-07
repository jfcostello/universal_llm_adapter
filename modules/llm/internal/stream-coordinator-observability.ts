import type {
  AdapterLogger,
  Message,
  ObservabilityContext,
  UsageStats
} from '../../../kernel/index.js';

import { deriveObservabilityModel, logObservabilityEvent, monotonicElapsedMs } from '../../shared/index.js';
import { filterContentForObservability, filterMessagesForObservability } from '../../shared/index.js';
import { redactJsonCredentials } from '../../security/index.js';

export function recordStreamLlmRequestObservability(options: {
  observability: ObservabilityContext;
  logger: AdapterLogger;
  metadata?: Record<string, any>;
  generationId: string | undefined;
  timestampMs: number;
  provider: string;
  model: string;
  messages: Message[];
  tools: any[];
  settings: any;
}): void {
  try {
    const captureMessages = options.observability.captureMessages ?? 'full';

    const event = {
      traceId: options.observability.traceId,
      generationId: options.generationId,
      timestampMs: options.timestampMs,
      provider: options.provider,
      model: options.model,
      messages: filterMessagesForObservability(options.messages, captureMessages),
      sessionId: options.observability.sessionId,
      metadata: options.observability.metadata,
      tools: redactJsonCredentials(options.tools) as any,
      settings: options.settings as any
    };

    options.observability.exporter.recordLLMRequest(event as any);

    if (process.env.LLM_LIVE !== '1') return;
    try {
      logObservabilityEvent(
        {
          eventType: 'LLM_REQUEST',
          traceId: event.traceId,
          generationId: event.generationId,
          event
        },
        options.metadata
      );
    } catch {
      // ignore
    }
  } catch (e) {
    options.logger?.warning?.('Failed to record observability request event', {
      error: (e as Error).message
    });
  }
}

export function recordStreamLlmResponseObservability(options: {
  observability: ObservabilityContext;
  logger: AdapterLogger;
  metadata?: Record<string, any>;
  generationId: string | undefined;
  startTimeMonoNs: bigint;
  provider: string;
  model: string;
  providerHint?: string;
  accumulatedContent: string;
  toolCalls: any[];
  usage?: UsageStats;
}): void {
  try {
    const captureMessages = options.observability.captureMessages ?? 'full';
    const captureToolArgs = options.observability.captureToolArgs ?? false;
    const observabilityModel = deriveObservabilityModel({
      provider: options.provider,
      model: options.model,
      providerHint: options.providerHint
    });

    const endTimeMs = Date.now();
    const durationMs = monotonicElapsedMs(options.startTimeMonoNs);
    const promptTokens = options.usage?.promptTokens ?? undefined;
    const completionTokens = options.usage?.completionTokens ?? undefined;
    const totalTokens = options.usage?.totalTokens ?? (
      typeof promptTokens === 'number' || typeof completionTokens === 'number'
        ? (promptTokens || 0) + (completionTokens || 0)
        : undefined
    );

    const event = {
      traceId: options.observability.traceId,
      generationId: options.generationId,
      sessionId: options.observability.sessionId,
      timestampMs: endTimeMs,
      provider: options.provider,
      model: observabilityModel,
      content: filterContentForObservability([{ type: 'text', text: options.accumulatedContent }] as any, captureMessages),
      toolCalls: options.toolCalls.map(tc => {
        const base = { id: (tc as any).id, name: (tc as any).name } as any;
        if (!captureToolArgs) return base;
        const args = (tc as any).arguments ?? (tc as any).args;
        const metadata = (tc as any).metadata;
        return {
          ...base,
          ...(args !== undefined ? { arguments: redactJsonCredentials(args) } : {}),
          ...(metadata !== undefined ? { metadata: redactJsonCredentials(metadata) } : {})
        };
      }),
      usage: options.usage ? {
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens: options.usage.cachedTokens ?? undefined,
        reasoningTokens: options.usage.reasoningTokens ?? undefined,
        audioTokens: options.usage.audioTokens ?? undefined,
        cost: options.usage.cost ?? undefined
      } : undefined,
      durationMs,
      metadata: options.observability.metadata
    };

    options.observability.exporter.recordLLMResponse(event as any);

    if (process.env.LLM_LIVE !== '1') return;
    try {
      logObservabilityEvent(
        {
          eventType: 'LLM_RESPONSE',
          traceId: event.traceId,
          generationId: event.generationId,
          event
        },
        options.metadata
      );
    } catch {
      // ignore
    }
  } catch (e) {
    options.logger?.warning?.('Failed to record observability response event', {
      error: (e as Error).message
    });
  }
}
