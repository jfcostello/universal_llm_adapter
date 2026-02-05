import type { ObservabilityCompatContext, ObservabilityProviderManifest, ObservabilitySignalEvent } from '../../../../kernel/index.js';
import { substituteEnv } from '../../../../kernel/index.js';

import { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from '../../../../modules/observability/index.js';
import { eventTimestampToIso, resolveMaxAttributeBytes, safeJsonStringify, truncateUtf8Bytes } from '../../../../modules/shared/index.js';

export type ParsedSentryDsn = {
  dsn: string;
  publicKey: string;
  projectId: string;
  envelopeUrl: string;
  otlpTracesUrl: string;
};

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function joinBaseAndPath(base: string, suffix: string): string {
  const normalizedBase = stripTrailingSlashes(base);
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${normalizedBase}${normalizedSuffix}`;
}

export function parseSentryDsn(rawDsn: string): ParsedSentryDsn {
  const dsn = String(rawDsn || '').trim();
  if (!dsn) {
    throw new Error('Invalid Sentry DSN: empty');
  }

  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error('Invalid Sentry DSN: not a URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid Sentry DSN: unsupported protocol '${url.protocol}'`);
  }

  const publicKey = String(url.username || '').trim();
  if (!publicKey) {
    throw new Error('Sentry DSN missing public key');
  }

  const segments = String(url.pathname)
    .split('/')
    .map(s => s.trim())
    .filter(Boolean);

  const projectId = segments.length > 0 ? String(segments[segments.length - 1]) : '';
  if (!projectId) {
    throw new Error('Sentry DSN missing project id');
  }

  const basePathSegments = segments.slice(0, -1);
  const basePath = basePathSegments.length > 0 ? `/${basePathSegments.join('/')}` : '';
  const baseUrl = `${url.protocol}//${url.host}${basePath}`;

  return {
    dsn,
    publicKey,
    projectId,
    envelopeUrl: joinBaseAndPath(baseUrl, `api/${projectId}/envelope/`),
    otlpTracesUrl: joinBaseAndPath(baseUrl, `/api/${projectId}/integration/otlp/v1/traces`)
  };
}

export function resolveSentryDsn(manifest: ObservabilityProviderManifest): string {
  const dsn = String(substituteEnv(manifest.endpoint.urlTemplate || '')).trim();
  if (!dsn) {
    throw new Error('Missing required env var for Sentry: SENTRY_DSN');
  }
  return dsn;
}

export function isOtlpEnabled(context?: ObservabilityCompatContext): boolean {
  return (context?.providerConfig as any)?.enableOtlp === true;
}

export function isToolResultSignalExportEnabled(context?: ObservabilityCompatContext): boolean {
  return (context?.providerConfig as any)?.exportToolResultsAsSignals === true;
}

export function normalizeSentryLevel(level: unknown): 'error' | 'warning' | 'info' | 'debug' {
  const raw = typeof level === 'string' ? level.trim().toLowerCase() : '';
  if (raw === 'error') return 'error';
  if (raw === 'warning' || raw === 'warn') return 'warning';
  if (raw === 'debug') return 'debug';
  return 'info';
}

function deriveSentryEventId(seed: string): string {
  const normalized = String(seed || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  if (normalized.length === 32) return normalized;
  return deriveOtlpTraceIdHex(seed);
}

export function buildSentrySignalEnvelope(options: {
  dsn: string;
  envelopeId: string;
  event: ObservabilitySignalEvent;
  traceContext: { sessionId?: string; traceName?: string; batchId?: string; tags?: string[] };
  context?: ObservabilityCompatContext;
}): { envelopeId: string; body: string } {
  const maxBytes = resolveMaxAttributeBytes(options.context);
  const eventId = deriveSentryEventId(options.envelopeId);

  const traceIdHex = deriveOtlpTraceIdHex(String(options.event.traceId || ''));
  const spanIdHex = options.event.generationId ? deriveOtlpSpanIdHex(String(options.event.generationId)) : undefined;

  const message =
    typeof options.event.message === 'string' && options.event.message.trim() !== ''
      ? options.event.message
      : options.event.code
        ? String(options.event.code)
        : 'signal';

  const extra: Record<string, unknown> = {};
  if (options.event.source) extra.source = options.event.source;
  if (options.event.code) extra.code = options.event.code;
  if (options.event.stack) extra.stack = truncateUtf8Bytes(String(options.event.stack), maxBytes);
  if (options.event.tags) extra.tags = options.event.tags;
  if (options.event.metadata) extra.metadata = safeJsonStringify(options.event.metadata, { maxBytes });

  const tags: Record<string, string> = {};
  if (options.traceContext.traceName) tags['llm.adapter.correlation_id'] = options.traceContext.traceName;
  if (options.traceContext.batchId) tags['llm.adapter.batch_id'] = options.traceContext.batchId;
  if (options.traceContext.sessionId) tags['llm.adapter.session_id'] = options.traceContext.sessionId;
  if (options.traceContext.tags?.length) tags['llm.adapter.tags'] = options.traceContext.tags.join(',');

  const eventPayload: Record<string, unknown> = {
    event_id: eventId,
    timestamp: eventTimestampToIso(options.event),
    level: normalizeSentryLevel(options.event.level),
    message: truncateUtf8Bytes(message, maxBytes),
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    contexts: {
      trace: {
        trace_id: traceIdHex,
        ...(spanIdHex ? { span_id: spanIdHex } : {})
      }
    },
    ...(Object.keys(extra).length > 0 ? { extra } : {})
  };

  const envelopeHeader = {
    event_id: eventId,
    dsn: options.dsn,
    sent_at: new Date().toISOString()
  };

  const payloadJson = JSON.stringify(eventPayload);
  const itemHeader: Record<string, unknown> = {
    type: 'event',
    content_type: 'application/json',
    length: Buffer.byteLength(payloadJson, 'utf8')
  };

  return {
    envelopeId: options.envelopeId,
    body: `${JSON.stringify(envelopeHeader)}\n${JSON.stringify(itemHeader)}\n${payloadJson}\n`
  };
}

export function buildSentryOtlpAuthHeader(publicKey: string): string {
  const key = String(publicKey || '').trim();
  if (!key) {
    throw new Error('Sentry OTLP auth requires a public key');
  }
  return `sentry sentry_key=${key}`;
}
