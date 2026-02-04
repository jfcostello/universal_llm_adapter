import type {
  HttpBatchResult,
  HttpCompatContext,
  HttpEnvelopeOutcome,
  HttpExportProviderManifest,
  IHttpBatchCompat
} from './http-exporter-types.js';

/**
 * Signals provider manifest (loaded from JSON).
 * Signals are provider-agnostic events (errors/warnings/info) that can be exported to external platforms.
 */
export type SignalsProviderManifest = HttpExportProviderManifest;

/**
 * Outcome of sending an individual envelope to the signals provider.
 */
export type SignalsEnvelopeOutcome = HttpEnvelopeOutcome;

/**
 * Result from sending a batch to the signals provider.
 */
export type SignalsBatchResult = HttpBatchResult;

/**
 * Optional context passed to signals compat modules.
 */
export type SignalsCompatContext = HttpCompatContext;

/**
 * Interface for signals compat modules.
 */
export interface ISignalsCompat extends IHttpBatchCompat<SignalsProviderManifest> {}

