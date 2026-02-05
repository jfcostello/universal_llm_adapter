import type {
  IObservabilityExporter,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent,
  ObservabilityRecordResult,
  ObservabilitySignalEvent,
  ObservabilityToolExecutionEvent,
  ObservabilityTraceUpdateEvent
} from '../../../../../kernel/index.js';

import { normalizeExportConfig } from './config.js';
import type { ObservabilityTargetExportConfig } from './config.js';

type TargetRuntime = {
  provider: string;
  exporter: IObservabilityExporter;
  export: ObservabilityTargetExportConfig;
};

function mergeRecordResults(results: ObservabilityRecordResult[]): ObservabilityRecordResult {
  const queued = results.some(r => r?.queued === true);
  const firstQueued = results.find(r => r?.queued === true);
  if (queued && firstQueued) {
    return { eventId: String(firstQueued.eventId || ''), queued: true };
  }
  return { eventId: '', queued: false, reason: 'disabled' };
}

export class MultiObservabilityExporter implements IObservabilityExporter {
  private targets: TargetRuntime[];

  constructor(
    targets: Array<{
      provider: string;
      exporter: IObservabilityExporter;
      export?: Partial<ObservabilityTargetExportConfig>;
    }>
  ) {
    this.targets = targets.map(t => ({
      provider: String(t.provider || '').trim(),
      exporter: t.exporter,
      export: normalizeExportConfig(t.export)
    })).filter(t => Boolean(t.provider) && Boolean(t.exporter));
  }

  recordLLMRequest(event: ObservabilityLLMRequestEvent): ObservabilityRecordResult {
    const results: ObservabilityRecordResult[] = [];
    for (const target of this.targets) {
      if (!target.export.traces) continue;
      results.push(target.exporter.recordLLMRequest(event));
    }
    return mergeRecordResults(results);
  }

  recordLLMResponse(event: ObservabilityLLMResponseEvent): ObservabilityRecordResult {
    const results: ObservabilityRecordResult[] = [];
    for (const target of this.targets) {
      if (!target.export.traces) continue;
      results.push(target.exporter.recordLLMResponse(event));
    }
    return mergeRecordResults(results);
  }

  recordToolExecution(event: ObservabilityToolExecutionEvent): ObservabilityRecordResult {
    const results: ObservabilityRecordResult[] = [];
    for (const target of this.targets) {
      if (!target.export.tools) continue;
      results.push(target.exporter.recordToolExecution(event));
    }
    return mergeRecordResults(results);
  }

  recordSignal(event: ObservabilitySignalEvent): ObservabilityRecordResult {
    const results: ObservabilityRecordResult[] = [];
    for (const target of this.targets) {
      if (!target.export.signals) continue;
      results.push(target.exporter.recordSignal(event));
    }
    return mergeRecordResults(results);
  }

  recordTraceUpdate(event: ObservabilityTraceUpdateEvent): ObservabilityRecordResult {
    const results: ObservabilityRecordResult[] = [];
    for (const target of this.targets) {
      if (!target.export.traceUpdates) continue;
      results.push(target.exporter.recordTraceUpdate(event));
    }
    return mergeRecordResults(results);
  }

  async flush(): Promise<void> {
    const unique = new Set<IObservabilityExporter>();
    for (const target of this.targets) unique.add(target.exporter);
    await Promise.all([...unique].map(exp => Promise.resolve().then(() => exp.flush()).catch(() => {})));
  }

  async shutdown(): Promise<void> {
    const unique = new Set<IObservabilityExporter>();
    for (const target of this.targets) unique.add(target.exporter);
    await Promise.all([...unique].map(exp => Promise.resolve().then(() => exp.shutdown()).catch(() => {})));
  }
}
