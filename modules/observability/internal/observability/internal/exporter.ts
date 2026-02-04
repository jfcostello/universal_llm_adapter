import type {
  IObservabilityCompat,
  IObservabilityExporter,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent,
  ObservabilityToolExecutionEvent,
  ObservabilityProviderManifest,
  ObservabilityRecordResult
} from '../../../../../kernel/index.js';

import { BatchedHttpExporter } from '../../../../batched-http-exporter/index.js';

import type { ObservabilityExporterConfig } from './config.js';

type ObservabilityQueuedType = 'llm_request' | 'llm_response' | 'tool_execution';
type ObservabilityQueuedData = ObservabilityLLMRequestEvent | ObservabilityLLMResponseEvent | ObservabilityToolExecutionEvent;

export class ObservabilityExporter
  extends BatchedHttpExporter<ObservabilityProviderManifest, ObservabilityQueuedType, ObservabilityQueuedData>
  implements IObservabilityExporter
{
  constructor(config: ObservabilityExporterConfig, compat: IObservabilityCompat, manifest: ObservabilityProviderManifest) {
    super(config, compat, manifest, 'Observability');
  }

  recordLLMRequest(event: ObservabilityLLMRequestEvent): ObservabilityRecordResult {
    return this.enqueue('llm_request', event);
  }

  recordLLMResponse(event: ObservabilityLLMResponseEvent): ObservabilityRecordResult {
    return this.enqueue('llm_response', event);
  }

  recordToolExecution(event: ObservabilityToolExecutionEvent): ObservabilityRecordResult {
    return this.enqueue('tool_execution', event);
  }
}
