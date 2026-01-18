import type { JsonObject, JsonValue } from './json.js';

export interface EndpointConfig {
  urlTemplate: string;
  method: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  // Optional streaming-specific overrides for providers whose streaming uses a different endpoint
  streamingUrlTemplate?: string;
  streamingHeaders?: Record<string, string>;
  streamingQuery?: Record<string, string>;
}

export interface RealtimeEndpointConfig {
  urlTemplate: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
}

export interface RealtimeWebrtcEndpointConfig {
  urlTemplate: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface RealtimeClientSecretEndpointConfig {
  urlTemplate: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/**
 * Realtime provider manifest (loaded from JSON).
 *
 * This is intentionally separate from `ProviderManifest` so realtime providers
 * can be configured independently from standard LLM request/response providers.
 */
export interface RealtimeProviderManifest {
  id: string;
  compat: string;
  endpoint: RealtimeEndpointConfig;
  webrtc?: {
    endpoint: RealtimeWebrtcEndpointConfig;
    clientSecretEndpoint?: RealtimeClientSecretEndpointConfig;
  };
  metadata?: JsonObject;
}

export interface ProviderPayloadExtension {
  name: string;
  settingsKey: string;
  targetPath: string[];
  valueType: "any" | "object" | "array" | "string" | "number" | "boolean";
  mergeStrategy?: "update" | "replace";
  default?: JsonValue;
  required?: boolean;
  description?: string;
  schema?: JsonObject;
}

export interface ProviderManifest {
  id: string;
  compat: string;
  endpoint: EndpointConfig;
  retryWords?: string[];
  metadata?: JsonObject;
  payloadExtensions?: ProviderPayloadExtension[];
  /** Provider-specific default settings (e.g., maxTokens, reasoningBudget) */
  defaults?: JsonObject;
}

export interface MCPServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
  autoStart?: boolean;
  capabilities?: JsonObject;
  requestTimeoutMs?: number;
}
