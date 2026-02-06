import type {
  AdapterLogger,
  ObservabilityContext,
  ObservabilitySignalLevel,
  RunContext
} from '../../../../../kernel/index.js';

import { redactJsonCredentials } from '../../../../security/index.js';
import {
  resolveObservabilityCaptureSettings,
  safeJsonStringify,
  safeJsonValue,
  truncateUtf8Bytes
} from '../../../../shared/index.js';

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function readRunContextGenerationId(runContext: unknown): string | undefined {
  if (!runContext || typeof runContext !== 'object') return undefined;
  return readTrimmedString((runContext as Partial<RunContext>).generationId);
}

function boundJsonValue(value: unknown, maxJsonBytes: number): unknown {
  if (!Number.isFinite(maxJsonBytes) || maxJsonBytes <= 0) return undefined;
  return safeJsonValue(value, { maxBytes: Math.floor(maxJsonBytes) });
}

function buildResultText(value: unknown, options: { maxChars: number | null; maxBytes: number }): string | undefined {
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(0, Math.floor(options.maxBytes)) : 0;
  if (maxBytes <= 0) return '';

  let raw = typeof value === 'string'
    ? value
    : safeJsonStringify(value, { maxBytes });

  if (options.maxChars && options.maxChars > 0 && raw.length > options.maxChars) {
    raw = `${raw.slice(0, options.maxChars)}…`;
  }

  return truncateUtf8Bytes(raw, maxBytes);
}

export function recordToolExecutionObservability(options: {
  observability: ObservabilityContext | undefined;
  logger: AdapterLogger;
  generationId: string | undefined;
  provider: string;
  model: string;
  toolCallId: string;
  toolName: string;
  timestampMs: number;
  durationMs?: number;
  args?: unknown;
  result?: unknown;
  skipped?: boolean;
  skipReason?: string;
  error?: { message: string; code?: string; stack?: string; retryable?: boolean };
  maxResultLength: number | null;
}): void {
  const obs = options.observability;
  if (!obs) return;

  try {
    const { captureMessages, captureToolArgs } = resolveObservabilityCaptureSettings(obs);

    const maxJsonBytes = typeof obs.maxJsonBytes === 'number' ? obs.maxJsonBytes : 8192;
    const maxOutputTextBytes = typeof obs.maxOutputTextBytes === 'number' ? obs.maxOutputTextBytes : 4096;

    const event: any = {
      traceId: obs.traceId,
      ...(options.generationId ? { generationId: options.generationId } : {}),
      ...(obs.sessionId ? { sessionId: obs.sessionId } : {}),
      timestampMs: options.timestampMs,
      provider: options.provider,
      model: options.model,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      ...(typeof options.durationMs === 'number' ? { durationMs: options.durationMs } : {}),
      ...(options.skipped ? { skipped: true } : {}),
      ...(options.skipReason ? { skipReason: options.skipReason } : {}),
      ...(options.error ? { error: options.error } : {}),
      metadata: obs.metadata
    };

    if (captureToolArgs && options.args !== undefined) {
      const redactedArgs = redactJsonCredentials(options.args);
      event.args = boundJsonValue(redactedArgs, maxJsonBytes);
    }

    if (captureMessages !== 'none' && options.result !== undefined) {
      const redactedResult = redactJsonCredentials(options.result);
      const resultText = buildResultText(redactedResult, {
        maxChars: options.maxResultLength,
        maxBytes: maxOutputTextBytes
      });

      if (captureMessages === 'full') {
        const bounded = boundJsonValue(redactedResult, maxJsonBytes);
        if (bounded !== undefined) {
          event.result = bounded;
        }
      }

      if (resultText !== undefined) {
        event.resultText = resultText;
      }
    }

    obs.exporter.recordToolExecution(event);
  } catch (e) {
    options.logger?.warning?.('Failed to record observability tool execution event', {
      error: (e as Error)?.message ?? String(e)
    });
  }
}

export function recordToolFailureSignal(options: {
  observability: ObservabilityContext | undefined;
  logger: AdapterLogger;
  generationId: string | undefined;
  timestampMs: number;
  level: ObservabilitySignalLevel;
  code: string;
  message: string;
  stack?: string;
  toolCallId: string;
  toolName: string;
  provider: string;
  model: string;
  skipReason?: string;
}): void {
  const obs = options.observability;
  if (!obs) return;

  try {
    obs.exporter.recordSignal({
      traceId: obs.traceId,
      ...(options.generationId ? { generationId: options.generationId } : {}),
      ...(obs.sessionId ? { sessionId: obs.sessionId } : {}),
      timestampMs: options.timestampMs,
      level: options.level,
      message: options.message,
      source: 'tool_loop',
      code: options.code,
      ...(options.stack ? { stack: options.stack } : {}),
      metadata: {
        ...(obs.metadata ?? {}),
        tool: {
          name: options.toolName,
          callId: options.toolCallId,
          provider: options.provider,
          model: options.model,
          ...(options.skipReason ? { skipReason: options.skipReason } : {})
        }
      }
    } as any);
  } catch (e) {
    options.logger?.warning?.('Failed to record observability signal event', {
      error: (e as Error)?.message ?? String(e)
    });
  }
}
