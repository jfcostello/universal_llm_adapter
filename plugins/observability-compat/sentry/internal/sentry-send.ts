import type {
  ObservabilityBatchResult,
  ObservabilityCompatContext,
  ObservabilityProviderManifest
} from '../../../../kernel/index.js';

import type { OtlpSpanSpec } from '../../../../modules/observability/index.js';
import { clampInt, setUnrefTimeout, truncateUtf8Bytes, safeJsonStringify } from '../../../../modules/shared/index.js';
import { redactJsonCredentials } from '../../../../modules/security/index.js';

import {
  buildSentryOtlpAuthHeader,
  isOtlpEnabled,
  parseSentryDsn,
  resolveSentryDsn
} from './sentry-helpers.js';

const DEFAULT_ENVELOPE_CONCURRENCY = 2;
const MAX_ENVELOPE_CONCURRENCY = 10;

const DEFAULT_ERROR_BODY_MAX_BYTES = 1024;
const MAX_ERROR_BODY_MAX_BYTES = 64 * 1024;

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

function resolveEnvelopeConcurrency(context?: ObservabilityCompatContext): number {
  const providerConfig = context?.providerConfig;
  const raw =
    providerConfig && typeof providerConfig === 'object'
      ? (providerConfig as any).envelopeConcurrency
      : undefined;
  return clampInt(raw, DEFAULT_ENVELOPE_CONCURRENCY, 1, MAX_ENVELOPE_CONCURRENCY);
}

function resolveIncludeResponseBodyOnError(context?: ObservabilityCompatContext): boolean {
  const providerConfig = context?.providerConfig;
  return !!(providerConfig && typeof providerConfig === 'object' && (providerConfig as any).includeResponseBodyOnError === true);
}

function resolveErrorBodyMaxBytes(context?: ObservabilityCompatContext): number {
  const providerConfig = context?.providerConfig;
  const raw =
    providerConfig && typeof providerConfig === 'object'
      ? (providerConfig as any).errorResponseBodyMaxBytes
      : undefined;
  return clampInt(raw, DEFAULT_ERROR_BODY_MAX_BYTES, 0, MAX_ERROR_BODY_MAX_BYTES);
}

async function tryReadSafeErrorBody(options: {
  response: any;
  maxBytes: number;
}): Promise<string | null> {
  if (options.maxBytes <= 0) return null;
  if (!options.response || typeof options.response.text !== 'function') return null;

  let text: string;
  try {
    text = await options.response.text();
  } catch {
    return null;
  }

  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      const redacted = redactJsonCredentials(parsed);
      const json = safeJsonStringify(redacted);
      return truncateUtf8Bytes(json, options.maxBytes);
    } catch {
      // fall through
    }
  }

  return truncateUtf8Bytes(trimmed, options.maxBytes);
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
  if (envelopes.length > 0) {
    const includeResponseBodyOnError = resolveIncludeResponseBodyOnError(context);
    const errorBodyMaxBytes = resolveErrorBodyMaxBytes(context);

    const sendEnvelope = async (envelope: { envelopeId: string; body: string }): Promise<void> => {
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
        timeoutId = setUnrefTimeout(() => controller.abort(), timeoutMs);
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
          return;
        }

        overallSuccess = false;

        let errorMessage =
          typeof (res as any)?.statusText === 'string' && (res as any).statusText
            ? `HTTP ${res.status}: ${(res as any).statusText}`
            : `HTTP ${res.status}`;

        if (includeResponseBodyOnError) {
          const body = await tryReadSafeErrorBody({ response: res as any, maxBytes: errorBodyMaxBytes });
          if (body) {
            errorMessage = `${errorMessage}; body: ${body}`;
          }
        }

        outcomes.push({
          envelopeId: envelope.envelopeId,
          success: false,
          status: res.status,
          error: errorMessage,
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
    };

    const concurrency = resolveEnvelopeConcurrency(context);
    const workerCount = Math.min(concurrency, envelopes.length);
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= envelopes.length) return;
        await sendEnvelope(envelopes[index]);
      }
    });

    await Promise.all(workers);
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
