import { createHash } from 'crypto';

import type {
  ISignalsCompat,
  SignalEvent,
  SignalsBatchResult,
  SignalsCompatContext,
  SignalsProviderManifest
} from '../../../../kernel/index.js';
import { readTrimmedStringProperty, safeJsonStringify, truncateUtf8Bytes } from '../../../../modules/shared/index.js';

type SentryEnvelopePayload = {
  envelopes: Array<{
    envelopeId: string;
    body: string;
  }>;
};

function isAllZeroHex(hex: string): boolean {
  return /^0+$/.test(String(hex).trim().toLowerCase());
}

function deriveSentryEventIdHex(seed: string): string {
  const normalized = String(seed).trim().toLowerCase().replace(/-/g, '');
  if (/^[0-9a-f]{32}$/.test(normalized) && !isAllZeroHex(normalized)) {
    return normalized;
  }

  const digest = createHash('sha256').update(String(seed)).digest();
  const slice = Buffer.from(digest.subarray(0, 16));
  let hex = slice.toString('hex');
  if (isAllZeroHex(hex)) {
    const patched = Buffer.from(slice);
    patched[patched.length - 1] = 1;
    hex = patched.toString('hex');
  }
  return hex;
}

function toSentryLevel(level: unknown): 'debug' | 'info' | 'warning' | 'error' {
  const raw = String(level).trim().toLowerCase();
  if (raw === 'debug') return 'debug';
  if (raw === 'warning') return 'warning';
  if (raw === 'error') return 'error';
  return 'info';
}

function isSignalEvent(event: any): event is SignalEvent {
  return !!event &&
    typeof event === 'object' &&
    typeof event.traceId === 'string' &&
    typeof event.generationId === 'string' &&
    typeof event.timestampMs === 'number' &&
    Number.isFinite(event.timestampMs) &&
    typeof event.message === 'string' &&
    typeof event.level === 'string';
}

function resolveEnvelopeId(eventIds: unknown, index: number): string {
  const ids = Array.isArray(eventIds) ? eventIds : [];
  const candidate = ids[index];
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  return trimmed || `signal-${index}`;
}

function resolveDsn(manifest: SignalsProviderManifest, context?: SignalsCompatContext): string | null {
  const fromConfig = readTrimmedStringProperty(context?.providerConfig, 'dsn');
  if (fromConfig) return fromConfig;

  const raw = typeof manifest?.endpoint?.urlTemplate === 'string' ? String(manifest.endpoint.urlTemplate) : '';
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function parseDsnToEnvelopeUrl(dsn: string): { envelopeUrl: string; key: string; secret?: string } {
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch (error: any) {
    throw new Error(`Invalid Sentry DSN: ${String(error)}`);
  }

  const key = String(parsed.username).trim();
  const secret = String(parsed.password).trim() || undefined;

  const segments = String(parsed.pathname)
    .split('/')
    .map(s => s.trim())
    .filter(Boolean);

  const projectId = segments.length > 0 ? segments[segments.length - 1] : '';
  const pathPrefix = segments.length > 1 ? `/${segments.slice(0, -1).join('/')}` : '';

  if (!key) throw new Error('Invalid Sentry DSN: missing public key');
  if (!projectId) throw new Error('Invalid Sentry DSN: missing project id');

  const origin = `${parsed.protocol}//${parsed.host}`;
  const envelopeUrl = `${origin}${pathPrefix}/api/${projectId}/envelope/`;

  return { envelopeUrl, key, ...(secret ? { secret } : {}) };
}

function buildSentryAuthHeader(options: { key: string; secret?: string }): string {
  const parts = [
    'Sentry sentry_version=7',
    'sentry_client=universal_llm_adapter',
    `sentry_key=${options.key}`
  ];
  if (options.secret) parts.push(`sentry_secret=${options.secret}`);
  return parts.join(', ');
}

function parseRetryAfterMs(retryAfterHeader: string | null | undefined): number | null {
  if (!retryAfterHeader) return null;
  const raw = String(retryAfterHeader).trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.floor(seconds * 1000);
  }

  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return null;
  const delta = dateMs - Date.now();
  return delta > 0 ? Math.floor(delta) : null;
}

function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

function isAbortError(error: any): boolean {
  const name = typeof error?.name === 'string' ? error.name : '';
  const code = typeof error?.code === 'string' ? error.code : '';
  return name === 'AbortError' || code === 'ABORT_ERR';
}

function createAbortError(): Error {
  const error = new Error('Request aborted');
  (error as any).name = 'AbortError';
  return error;
}

export class SentrySignalsCompat implements ISignalsCompat {
  buildBatch(
    events: unknown[],
    _manifest: SignalsProviderManifest,
    context?: SignalsCompatContext
  ): { payload: SentryEnvelopePayload; eventIndexByEnvelopeId: Map<string, number> } {
    const envelopes: SentryEnvelopePayload['envelopes'] = [];
    const eventIndexByEnvelopeId = new Map<string, number>();

    const maxBytes = typeof context?.maxAttributeValueBytes === 'number' && Number.isFinite(context.maxAttributeValueBytes)
      ? Math.max(0, Math.floor(context.maxAttributeValueBytes))
      : 16384;

    for (let i = 0; i < events.length; i++) {
      const event = events[i] as any;
      if (!isSignalEvent(event)) continue;

      const envelopeId = resolveEnvelopeId(context?.eventIds, i);
      const sentryEventIdHex = deriveSentryEventIdHex(envelopeId);

      const metadata = event.metadata;
      const correlationId = truncateUtf8Bytes(readTrimmedStringProperty(metadata, 'correlationId') ?? '', maxBytes);
      const batchId = truncateUtf8Bytes(readTrimmedStringProperty(metadata, 'batchId') ?? '', maxBytes);
      const sessionId = truncateUtf8Bytes(readTrimmedStringProperty(metadata, 'sessionId') ?? '', maxBytes);

      const message = truncateUtf8Bytes(
        event.message && String(event.message).trim() !== '' ? String(event.message) : (event.code ? String(event.code) : 'signal'),
        maxBytes
      );

      const level = toSentryLevel(event.level);

      const tags: Record<string, string> = {};
      if (event.tags && typeof event.tags === 'object' && !Array.isArray(event.tags)) {
        for (const [k, v] of Object.entries(event.tags)) {
          const key = String(k).trim();
          if (!key) continue;
          const value = truncateUtf8Bytes(String(v ?? '').trim(), maxBytes);
          if (!value) continue;
          tags[key] = value;
        }
      }

      tags['llm.adapter.trace_id'] = truncateUtf8Bytes(String(event.traceId), maxBytes);
      tags['llm.adapter.generation_id'] = truncateUtf8Bytes(String(event.generationId), maxBytes);
      if (event.code) tags['llm.adapter.code'] = truncateUtf8Bytes(String(event.code), maxBytes);
      if (correlationId) tags['llm.adapter.correlation_id'] = correlationId;
      if (batchId) tags['llm.adapter.batch_id'] = batchId;
      if (sessionId) tags['llm.adapter.session_id'] = sessionId;

      const sentAtIso = new Date(event.timestampMs).toISOString();

      const sentryEvent: Record<string, unknown> = {
        event_id: sentryEventIdHex,
        timestamp: sentAtIso,
        platform: 'javascript',
        logger: 'llm_adapter.signals',
        level,
        message,
        tags,
        extra: {
          ...(correlationId ? { correlationId } : {}),
          ...(batchId ? { batchId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(event.code ? { code: truncateUtf8Bytes(String(event.code), maxBytes) } : {}),
          ...(event.stack ? { stack: truncateUtf8Bytes(String(event.stack), maxBytes) } : {}),
          ...(event.metadata !== undefined ? { metadata: safeJsonStringify(event.metadata, { maxBytes }) } : {})
        }
      };

      const envelopeHeader = { event_id: sentryEventIdHex, sent_at: sentAtIso };
      const itemHeader = { type: 'event' };

      const body = `${JSON.stringify(envelopeHeader)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(sentryEvent)}\n`;

      envelopes.push({ envelopeId, body });
      eventIndexByEnvelopeId.set(envelopeId, i);
    }

    return { payload: { envelopes }, eventIndexByEnvelopeId };
  }

  async sendBatch(
    payload: unknown,
    manifest: SignalsProviderManifest,
    context?: SignalsCompatContext
  ): Promise<SignalsBatchResult> {
    const envelopes = Array.isArray((payload as any)?.envelopes)
      ? (((payload as any).envelopes as any[])
          .filter(e => e && typeof e === 'object' && typeof (e as any).envelopeId === 'string' && typeof (e as any).body === 'string')
          .map(e => ({ envelopeId: String((e as any).envelopeId), body: String((e as any).body) })))
      : [];

    if (envelopes.length === 0) {
      return { success: true, outcomes: [] };
    }

    const dsn = resolveDsn(manifest, context);
    if (!dsn) {
      const error = 'Missing Sentry DSN (set SENTRY_DSN or signals.targets[].providerConfig.dsn)';
      return {
        success: false,
        outcomes: envelopes.map(e => ({ envelopeId: e.envelopeId, success: false, error, retryable: false }))
      };
    }

    let envelopeUrl: string;
    let authHeader: string;
    try {
      const parsed = parseDsnToEnvelopeUrl(dsn);
      envelopeUrl = parsed.envelopeUrl;
      authHeader = buildSentryAuthHeader({ key: parsed.key, ...(parsed.secret ? { secret: parsed.secret } : {}) });
    } catch (error: any) {
      const message = String(error);
      return {
        success: false,
        outcomes: envelopes.map(e => ({ envelopeId: e.envelopeId, success: false, error: message, retryable: false }))
      };
    }

    const headers: Record<string, string> = {
      ...(manifest.endpoint.headers ?? {}),
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': authHeader
    };

    const outcomes: SignalsBatchResult['outcomes'] = [];
    let overallSuccess = true;

    for (const envelope of envelopes) {
      if (context?.signal?.aborted) {
        throw createAbortError();
      }

      const controller = new AbortController();
      let cleanupSignal: (() => void) | undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      if (typeof context?.timeoutMs === 'number' && Number.isFinite(context.timeoutMs)) {
        timeoutId = setTimeout(() => controller.abort(), Math.max(0, Math.floor(context.timeoutMs)));
      }

      try {
        if (context?.signal) {
          const onAbort = () => controller.abort();
          cleanupSignal = () => context.signal?.removeEventListener('abort', onAbort);
          context.signal.addEventListener('abort', onAbort, { once: true });
        }

        const res = await fetch(envelopeUrl, {
          method: 'POST',
          headers,
          body: envelope.body,
          signal: controller.signal
        });

        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }

        if (res.ok) {
          outcomes.push({ envelopeId: envelope.envelopeId, success: true, status: res.status });
          continue;
        }

        overallSuccess = false;
        const retryable = isRetryableStatus(res.status);
        const statusText = typeof (res as any).statusText === 'string' ? String((res as any).statusText) : '';
        const errorText = statusText ? `HTTP ${res.status}: ${statusText}` : `HTTP ${res.status}`;

        outcomes.push({
          envelopeId: envelope.envelopeId,
          success: false,
          status: res.status,
          error: errorText,
          retryable
        });

        if (res.status === 429) {
          const retryAfterHeader = (res as any)?.headers?.get?.('retry-after');
          const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
          if (retryAfterMs && retryAfterMs > 0) {
            // Best-effort cooldown within sendBatch to reduce repeated 429s.
            await new Promise(resolve => setTimeout(resolve, Math.min(retryAfterMs, 60_000)));
          }
        }
      } catch (error: any) {
        if (context?.signal?.aborted || isAbortError(error)) {
          throw createAbortError();
        }
        overallSuccess = false;
        const message = String(error);
        outcomes.push({ envelopeId: envelope.envelopeId, success: false, error: message, retryable: true });
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        cleanupSignal?.();
      }
    }

    return {
      success: overallSuccess && outcomes.every(o => o.success),
      outcomes
    };
  }
}

export default SentrySignalsCompat;
