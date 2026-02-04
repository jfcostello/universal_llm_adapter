import type { AdapterLogger, ObservabilityContext } from '../../../../../kernel/index.js';

import { redactJsonCredentials } from '../../../../security/index.js';
import { logObservabilityEvent } from '../../../../shared/index.js';

export function recordToolExecutionObservability(options: {
  observability: ObservabilityContext | undefined;
  logger: AdapterLogger;
  metadata?: Record<string, any>;
  generationId: string | undefined;
  provider: string;
  model: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  resultText: string;
  error?: { message: string; code?: string; retryable?: boolean };
  startTimeMs: number;
  endTimeMs: number;
}): void {
  const observability = options.observability;
  if (!observability) return;

  try {
    const captureMessages = observability.captureMessages ?? 'full';
    const captureToolArgs = observability.captureToolArgs ?? true;

    const event: any = {
      traceId: observability.traceId,
      generationId: options.generationId,
      sessionId: observability.sessionId,
      startTimeMs: options.startTimeMs,
      endTimeMs: options.endTimeMs,
      provider: options.provider,
      model: options.model,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      metadata: observability.metadata
    };

    if (captureToolArgs && options.args !== undefined) {
      event.args = redactJsonCredentials(options.args);
    }

    if (captureMessages !== 'none') {
      if (captureMessages === 'full') {
        event.result = redactJsonCredentials(options.result);
        event.resultText = options.resultText;
      } else {
        event.resultText = options.resultText;
      }
    }

    if (options.error) {
      event.error = {
        message: String(options.error.message || 'error'),
        ...(options.error.code ? { code: String(options.error.code) } : {}),
        ...(options.error.retryable !== undefined ? { retryable: !!options.error.retryable } : {})
      };
    }

    observability.exporter.recordToolExecution(event);

    if (process.env.LLM_LIVE !== '1') return;
    try {
      logObservabilityEvent(
        {
          eventType: 'TOOL_EXECUTION',
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
    options.logger?.warning?.('Failed to record observability tool execution event', {
      error: (e as Error).message
    });
  }
}
