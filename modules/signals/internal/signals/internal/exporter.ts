import type { ISignalsCompat, SignalEvent, SignalLevel, SignalsProviderManifest, SignalsRecordResult } from '../../../../../kernel/index.js';
import { BatchedHttpExporter } from '../../../../batched-http-exporter/index.js';
import { redactJsonCredentials } from '../../../../security/index.js';

import type { SignalsTargetExporterConfig } from './config.js';

export class SignalsExporter
  extends BatchedHttpExporter<SignalsProviderManifest, SignalLevel, SignalEvent>
{
  private target: string;

  constructor(config: SignalsTargetExporterConfig, compat: ISignalsCompat, manifest: SignalsProviderManifest) {
    super(config, compat, manifest, 'Signals');
    this.target = String(config.provider);
  }

  recordSignal(event: SignalEvent): SignalsRecordResult {
    const result = this.enqueue(event.level, event);
    return {
      queued: result.queued,
      ...(result.reason ? { reason: result.reason } : {}),
      results: [
        {
          target: this.target,
          eventId: result.eventId,
          queued: result.queued,
          ...(result.reason ? { reason: result.reason } : {})
        }
      ]
    };
  }
}

export class SignalsFanoutExporter {
  constructor(public exporters: SignalsExporter[]) {}

  recordSignal(event: SignalEvent): SignalsRecordResult {
    const redactedEvent: SignalEvent = event.metadata !== undefined
      ? { ...event, metadata: redactJsonCredentials(event.metadata) as any }
      : event;

    const results: SignalsRecordResult['results'] = [];
    let anyQueued = false;
    let firstReason: string | undefined;

    for (const exp of this.exporters) {
      const res = exp.recordSignal(redactedEvent);
      results.push(...res.results);
      if (res.queued) {
        anyQueued = true;
      } else if (!firstReason && res.reason) {
        firstReason = res.reason;
      }
    }

    return {
      queued: anyQueued,
      ...(!anyQueued && firstReason ? { reason: firstReason } : {}),
      results
    };
  }

  async flush(): Promise<void> {
    await Promise.all(this.exporters.map(exp => exp.flush()));
  }
}
