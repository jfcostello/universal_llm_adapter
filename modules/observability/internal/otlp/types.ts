export interface OtlpSpanSpec {
  /**
   * OTLP traceId as 32 lowercase hex chars (16 bytes).
   */
  traceIdHex: string;

  /**
   * OTLP spanId as 16 lowercase hex chars (8 bytes).
   */
  spanIdHex: string;

  /**
   * Optional OTLP parent spanId as 16 lowercase hex chars (8 bytes).
   */
  parentSpanIdHex?: string;

  /**
   * Span name.
   */
  name: string;

  /**
   * Span start time (ISO 8601).
   */
  startTimeIso: string;

  /**
   * Span end time (ISO 8601).
   */
  endTimeIso: string;

  /**
   * Span attributes.
   * Values should be primitive-ish (string/number/boolean/arrays/objects) per OTLP AnyValue.
   */
  attributes?: Record<string, unknown>;

  /**
   * Span status.
   */
  status?: {
    code: 'UNSET' | 'OK' | 'ERROR';
    message?: string;
  };

  /**
   * Envelope identifier used by the observability exporter for retry correlation.
   * Not part of OTLP, but carried alongside the span spec for batching.
   */
  envelopeId?: string;
}

