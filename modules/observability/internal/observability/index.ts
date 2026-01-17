export { ObservabilityExporter } from './internal/exporter.js';
export type { ObservabilityExporterConfig } from './internal/config.js';
export { createObservabilityDeps } from './internal/create-deps.js';

// Re-export kernel types and functions
export { getNoopObservabilityDeps, resolveObservabilityDeps } from '../../../../kernel/index.js';
export type {
  ObservabilityDeps,
  IObservabilityExporter,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent,
  ObservabilityRecordResult
} from '../../../../kernel/index.js';
