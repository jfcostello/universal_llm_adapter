import type {
  HttpAuthConfig,
  HttpBatchResult,
  HttpCompatContext,
  HttpEnvelopeOutcome,
  HttpExportProviderManifest,
  HttpProviderLimits,
  IHttpBatchCompat
} from './http-exporter-types.js';

/**
 * Observability provider/compat types.
 *
 * Observability and signals share the same batched HTTP exporter primitives, but we keep
 * separate type aliases to preserve semantics and keep public APIs stable.
 */
export type ObservabilityAuthConfig = HttpAuthConfig;
export type ObservabilityProviderLimits = HttpProviderLimits;
export type ObservabilityProviderManifest = HttpExportProviderManifest;
export type ObservabilityEnvelopeOutcome = HttpEnvelopeOutcome;
export type ObservabilityBatchResult = HttpBatchResult;
export type ObservabilityCompatContext = HttpCompatContext;

export interface IObservabilityCompat extends IHttpBatchCompat<ObservabilityProviderManifest> {}
