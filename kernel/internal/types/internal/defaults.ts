import type { ObservabilityTargetSpec } from '../../observability-spec-types.js';

/**
 * Retry and rate limiting default settings.
 */
export interface RetryDefaults {
  maxAttempts: number;
  baseDelayMs: number;
  multiplier: number;
  rateLimitDelays: number[];
}

/**
 * Tool execution default settings.
 */
export interface ToolDefaults {
  countdownEnabled: boolean;
  finalPromptEnabled: boolean;
  parallelExecution: boolean;
  preserveResults: number;
  preserveReasoning: number;
  maxIterations: number;
  timeoutMs: number;
}

/**
 * Settings for constructing the embedding query from conversation messages.
 */
export interface QueryConstructionSettings {
  /**
   * Whether to include the system prompt in the embedding query.
   * - 'always': Always include system prompt
   * - 'never': Never include system prompt
   * - 'if-in-range': Include only if messagesToInclude covers the system message
   */
  includeSystemPrompt: 'always' | 'never' | 'if-in-range';

  /**
   * Whether to include assistant messages in the embedding query.
   */
  includeAssistantMessages: boolean;

  /**
   * Number of messages to include in the embedding query.
   * 0 = all messages, 1 = most recent only, 2 = last 2 messages, etc.
   */
  messagesToInclude: number;
}

export interface VectorDefaults {
  topK: number;
  injectTemplate: string;
  resultFormat: string;
  batchSize: number;
  includePayload: boolean;
  includeVector: boolean;
  defaultCollection: string;
  queryConstruction: QueryConstructionSettings;
}

/**
 * Text chunking default settings.
 */
export interface ChunkingDefaults {
  size: number;
  overlap: number;
}

/**
 * Token estimation default settings.
 */
export interface TokenEstimationDefaults {
  textDivisor: number;
  imageEstimate: number;
  toolResultDivisor: number;
}

/**
 * Security-related defaults.
 */
export interface RedactionDefaults {
  /**
   * Key names/patterns that should be redacted when sanitizing JSON/URLs and serializing logs.
   * Supports `*` wildcard patterns (glob-style), case-insensitive.
   */
  sensitiveKeys: string[];
}

export interface SecurityDefaults {
  redaction: RedactionDefaults;
}

/**
 * Timeout default settings (all values in milliseconds).
 */
export interface TimeoutDefaults {
  mcpRequest: number;
  llmHttp: number;
  embeddingHttp: number;
  loggerFlush: number;
}

/**
 * Server (HTTP/SSE) default settings.
 */
export type ServerAuthDefaults =
  | { mode: 'none' }
  | {
      mode: 'apiKey';
      allowBearer?: boolean;
      allowHeader?: boolean;
      headerName?: string;
      realm?: string;
      keys?: Array<{ id: string; token?: string; sha256?: string }>;
    }
  | {
      mode: 'jwt';
      allowBearer?: boolean;
      allowHeader?: boolean;
      headerName?: string;
      realm?: string;
      spki?: string;
      jwksUrl?: string;
      jwks?: unknown;
      jwksTimeoutMs?: number;
      jwksCooldownMs?: number;
      jwksCacheMaxAgeMs?: number;
      jwksMaxBytes?: number;
      issuer?: string | string[];
      audience?: string | string[];
      algorithms?: string[];
      clockToleranceSeconds?: number;
      subjectClaim?: string;
      tenantClaim?: string;
      scopesClaim?: string;
      scopesSeparator?: string;
      requireSubject?: boolean;
      requireExp?: boolean;
      cacheMaxEntries?: number;
    }
  | {
      mode: 'proxySigned';
      realm?: string;
      headers?: {
        signature?: string;
        keyId?: string;
        timestamp?: string;
        subject?: string;
        tenant?: string;
        scopes?: string;
      };
      maxSkewSeconds?: number;
      scopesSeparator?: string;
      keys?: Array<{ id: string; secret: string }>;
    };

export interface ServerRateLimitDefaults {
  enabled: boolean;
  requestsPerMinute: number;
  burst: number;
  trustProxyHeaders: boolean;
  /** Maximum number of distinct client keys tracked in memory */
  maxKeys: number;
  /** Optional TTL (ms) after which an idle key's bucket is reset */
  keyTtlMs: number;
}

export interface ServerCorsDefaults {
  enabled: boolean;
  allowedOrigins: string[] | '*';
  allowedHeaders: string[];
  allowCredentials: boolean;
}

export interface ServerPolicyDefaults {
  documents: {
    filepath: {
      enabled: boolean;
      allowedRoots: string[];
    };
  };
}

export interface ServerExtensionsDefaults {
  /**
   * Enabled extension names.
   * Extensions are optional features that bolt new services onto the server/CLI.
   */
  enabled: string[];
  /**
   * Extension-specific defaults (e.g. `extensions.voice`).
   */
  [key: string]: any;
}

export interface ServerDefaults {
  maxRequestBytes: number;
  bodyReadTimeoutMs: number;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxConcurrentRequests: number;
  maxConcurrentStreams: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
  maxConcurrentVectorRequests: number;
  maxConcurrentVectorStreams: number;
  vectorMaxQueueSize: number;
  vectorQueueTimeoutMs: number;
  maxConcurrentEmbeddingRequests: number;
  embeddingMaxQueueSize: number;
  embeddingQueueTimeoutMs: number;
  auth: ServerAuthDefaults;
  rateLimit: ServerRateLimitDefaults;
  cors: ServerCorsDefaults;
  policy: ServerPolicyDefaults;
  securityHeadersEnabled: boolean;
  httpHeadersTimeoutMs: number;
  httpRequestTimeoutMs: number;
  httpKeepAliveTimeoutMs: number;
  httpMaxHeadersCount: number;
  extensions?: ServerExtensionsDefaults;
}

/**
 * Path default settings.
 */
export interface PathDefaults {
  plugins: string;
}

/**
 * Observability default settings.
 * Controls optional export of LLM request/response data to observability platforms.
 */
export interface ObservabilityDefaults {
  /**
   * Whether observability is enabled globally.
   * Individual calls can override this via spec.observability.enabled.
   * @default false
   */
  enabled: boolean;

  /**
   * Default observability provider ID.
   * Must match an ID from plugins/observability-providers/*.json.
   */
  provider?: string;

  /**
   * Optional multi-target observability configuration.
   * When provided, this takes precedence over `provider`.
   */
  targets?: ObservabilityTargetSpec[];

  /**
   * Number of events to accumulate before triggering a flush.
   * @default 10
   */
  flushAt: number;

  /**
   * Maximum interval (ms) between flushes.
   * @default 5000
   */
  flushIntervalMs: number;

  /**
   * Maximum number of events to hold in the queue.
   * When exceeded, oldest events are dropped with a warning.
   * @default 1000
   */
  maxQueueSize: number;

  /**
   * Maximum retry attempts for failed exports.
   * @default 3
   */
  maxAttempts: number;

  /**
   * Base delay (ms) for exponential backoff on retries.
   * @default 250
   */
  baseDelayMs: number;

  /**
   * Maximum delay (ms) cap for exponential backoff.
   * @default 30000
   */
  maxDelayMs: number;

  /**
   * HTTP request timeout (ms) for export requests.
   * @default 10000
   */
  timeoutMs: number;

  /**
   * Maximum time (ms) to wait for observability shutdown/flush before giving up.
   * This prevents process shutdown from hanging indefinitely on retries/timeouts.
   * Set to 0 to disable the shutdown cap (wait unbounded).
   * @default 5000
   */
  shutdownTimeoutMs: number;

  /**
   * Maximum UTF-8 bytes for any exported attribute string value.
   * Provider compats should truncate large fields to stay within ingestion limits.
   * @default 16384
   */
  maxAttributeValueBytes: number;

  /**
   * Capture level for message/content bodies.
   * - none: do not export prompt/response bodies
   * - text: export only text content parts (exclude tool results/doc blobs)
   * - full: export full structured message/content payloads
   * @default 'none'
   */
  captureMessages: 'none' | 'text' | 'full';

  /**
   * Whether to export tool-call arguments/metadata.
   * @default false
   */
  captureToolArgs: boolean;

  /**
   * Whether to export the final provider request payload (`requestPayload`).
   * @default false
   */
  captureRequestPayload: boolean;

  /**
   * Whether to export raw provider response payloads when available (`rawResponse`).
   * @default false
   */
  captureRawResponse: boolean;

  /**
   * Sampling rate (0..1). When < 1, calls may be skipped entirely.
   * @default 1
   */
  sampleRate: number;

  /**
   * Maximum UTF-8 bytes for aggregated input text exported by providers/compats.
   * @default 4096
   */
  maxInputTextBytes: number;

  /**
   * Maximum UTF-8 bytes for aggregated output text exported by providers/compats.
   * @default 4096
   */
  maxOutputTextBytes: number;

  /**
   * Maximum UTF-8 bytes for JSON-like serialized attributes (e.g. observation input/output).
   * @default 8192
   */
  maxJsonBytes: number;
}

/**
 * Root interface containing all default settings categories.
 * Loaded from plugins/configs/defaults.json
 */
export interface DefaultSettings {
  retry: RetryDefaults;
  tools: ToolDefaults;
  usageCost: boolean;
  vector: VectorDefaults;
  chunking: ChunkingDefaults;
  tokenEstimation: TokenEstimationDefaults;
  security: SecurityDefaults;
  timeouts: TimeoutDefaults;
  server: ServerDefaults;
  paths: PathDefaults;
  observability: ObservabilityDefaults;
}
