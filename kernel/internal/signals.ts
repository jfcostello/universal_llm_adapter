/**
 * Kernel-level signals dependency injection.
 * Mirrors the ObservabilityDeps pattern for exporting provider-agnostic signal events.
 *
 * Signals are disabled by default. When disabled, noop implementations are used.
 */

import type { PluginRegistry } from './registry.js';
import type { SignalsSpec } from './signals-spec-types.js';

export type SignalLevel = 'debug' | 'info' | 'warning' | 'error';

export interface SignalEvent {
  traceId: string;
  generationId: string;
  timestampMs: number;
  level: SignalLevel;
  message: string;
  code?: string;
  stack?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface SignalsRecordResult {
  queued: boolean;
  reason?: string;
  results: Array<{
    target: string;
    eventId: string;
    queued: boolean;
    reason?: string;
  }>;
}

export interface ISignalsExporter {
  recordSignal(event: SignalEvent): SignalsRecordResult;
  flush(): Promise<void>;
}

export interface SignalsDeps {
  isEnabled: () => boolean;
  getExporter: () => ISignalsExporter;
  shutdown: () => Promise<void>;
}

function createNoopRecordResult(): SignalsRecordResult {
  return {
    queued: false,
    reason: 'disabled',
    results: []
  };
}

function createNoopExporter(): ISignalsExporter {
  const noopResult = createNoopRecordResult();
  return {
    recordSignal: () => noopResult,
    flush: async () => {}
  };
}

let cachedNoopExporter: ISignalsExporter | null = null;

const noopSignalsDeps: SignalsDeps = {
  isEnabled: () => false,
  getExporter: () => cachedNoopExporter ?? (cachedNoopExporter = createNoopExporter()),
  shutdown: async () => {
    cachedNoopExporter = null;
  }
};

export function getNoopSignalsDeps(): SignalsDeps {
  return noopSignalsDeps;
}

export function resolveSignalsDeps(overrides: Partial<SignalsDeps> = {}): SignalsDeps {
  return {
    isEnabled: overrides.isEnabled ?? noopSignalsDeps.isEnabled,
    getExporter: overrides.getExporter ?? noopSignalsDeps.getExporter,
    shutdown: overrides.shutdown ?? noopSignalsDeps.shutdown
  };
}

export interface CreateSignalsDepsConfig {
  registry: PluginRegistry;
  spec?: SignalsSpec;
}
