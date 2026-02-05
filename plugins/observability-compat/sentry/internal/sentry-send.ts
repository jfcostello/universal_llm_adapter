import type {
  ObservabilityBatchResult,
  ObservabilityCompatContext,
  ObservabilityProviderManifest
} from '../../../../kernel/index.js';

import type { OtlpSpanSpec } from '../../../../modules/observability/index.js';

import {
  buildSentryOtlpAuthHeader,
  isOtlpEnabled,
  parseSentryDsn,
  resolveSentryDsn
} from './sentry-helpers.js';

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && String((error as any).name) === 'AbortError';
}

function createAbortError(message = 'Aborted'): Error {
  const error = new Error(message);
  (error as any).name = 'AbortError';
  return error;
}

export async function sendSentryBatch(
  payload: unknown,
  manifest: ObservabilityProviderManifest,
  context?: ObservabilityCompatContext
): Promise<ObservabilityBatchResult> {
  const spans = Array.isArray((payload as any)?.spans) ? ((payload as any).spans as OtlpSpanSpec[]) : [];
  const envelopes = Array.isArray((payload as any)?.envelopes)
    ? ((payload as any).envelopes as Array<{ envelopeId: string; body: string }>)
    : [];

  if (spans.length === 0 && envelopes.length === 0) {
    return { success: true, outcomes: [] };
  }

  const dsn = resolveSentryDsn(manifest);
  const parsed = parseSentryDsn(dsn);

  const outcomes: ObservabilityBatchResult['outcomes'] = [];
  let overallSuccess = true;

  // Envelopes (signals/errors)
  for (const envelope of envelopes) {
    if (context?.signal?.aborted) {
      throw createAbortError();
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cleanupSignal: (() => void) | undefined;

    const timeoutMs =
      typeof context?.timeoutMs === 'number' && Number.isFinite(context.timeoutMs) && context.timeoutMs > 0
        ? Math.floor(context.timeoutMs)
        : undefined;

    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    try {
      if (context?.signal) {
        const onAbort = () => controller.abort();
        cleanupSignal = () => context.signal!.removeEventListener('abort', onAbort);
        context.signal.addEventListener('abort', onAbort, { once: true });
      }

      const res = await fetch(parsed.envelopeUrl, {
        method: 'POST',
        headers: {
          ...(manifest.endpoint.headers ?? {}),
          'Content-Type': 'application/x-sentry-envelope'
        },
        body: envelope.body,
        signal: controller.signal
      });

      if (res.ok) {
        outcomes.push({ envelopeId: envelope.envelopeId, success: true, status: res.status });
        continue;
      }

      overallSuccess = false;
      outcomes.push({
        envelopeId: envelope.envelopeId,
        success: false,
        status: res.status,
        error: typeof (res as any)?.statusText === 'string' && (res as any).statusText
          ? `HTTP ${res.status}: ${(res as any).statusText}`
          : `HTTP ${res.status}`,
        retryable: isRetryableStatus(res.status)
      });
    } catch (error: any) {
      if (context?.signal?.aborted || isAbortError(error)) {
        throw createAbortError();
      }
      overallSuccess = false;
      outcomes.push({
        envelopeId: envelope.envelopeId,
        success: false,
        error: (error as Error)?.message ?? String(error),
        retryable: true
      });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      cleanupSignal?.();
    }
  }

  // OTLP traces/tools
  if (isOtlpEnabled(context) && spans.length > 0) {
    const { sendOtlpTraceSpans } = await import('../../../../modules/observability/index.js');
    const otlp = await sendOtlpTraceSpans({
      spans,
      url: parsed.otlpTracesUrl,
      headers: {
        ...(manifest.endpoint.headers ?? {}),
        'Content-Type': 'application/x-protobuf',
        'x-sentry-auth': buildSentryOtlpAuthHeader(parsed.publicKey)
      },
      timeoutMs: context?.timeoutMs,
      maxBatchBytes: manifest.limits?.maxBatchBytes,
      signal: context?.signal
    });

    outcomes.push(...otlp.outcomes);
    if (!otlp.success) overallSuccess = false;
  }

  return {
    success: overallSuccess && outcomes.every(o => o.success),
    outcomes
  };
}

