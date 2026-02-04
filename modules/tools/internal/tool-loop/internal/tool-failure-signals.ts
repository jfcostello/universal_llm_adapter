import type {
  AdapterLogger,
  PluginRegistry,
  SignalsDeps,
  SignalsSpec,
  SignalLevel
} from '../../../../../kernel/index.js';
import { getDefaults } from '../../../../../kernel/index.js';

export type ToolFailureSignalEvent = {
  traceId?: string;
  generationId?: string;
  timestampMs: number;
  level: SignalLevel;
  message: string;
  code?: string;
  stack?: string;
  metadata?: Record<string, unknown>;
};

type GetSignalsDepsFn = (
  registry: PluginRegistry,
  spec: SignalsSpec | undefined,
  logger: AdapterLogger
) => Promise<SignalsDeps>;

export function createToolFailureSignalReporter(options: {
  registry: PluginRegistry;
  spec?: SignalsSpec;
  logger: AdapterLogger;
  getSignalsDeps?: GetSignalsDepsFn;
}): (event: ToolFailureSignalEvent) => Promise<void> {
  const defaults = getDefaults().signals;
  const enabled = options.spec?.enabled ?? defaults.enabled;
  const targets = options.spec?.targets ?? defaults.targets;
  const hasTargets = Array.isArray(targets) && targets.length > 0;

  if (!enabled || !hasTargets) {
    return async () => {};
  }

  let depsPromise: Promise<SignalsDeps> | null = null;

  const getDeps = async (): Promise<SignalsDeps> => {
    if (depsPromise) return depsPromise;

    depsPromise = (async () => {
      if (options.getSignalsDeps) {
        return await options.getSignalsDeps(options.registry, options.spec, options.logger);
      }

      const { createSignalsDeps } = await import('../../../../signals/index.js');
      return await createSignalsDeps(options.registry, options.spec, options.logger);
    })();

    return depsPromise;
  };

  return async (event: ToolFailureSignalEvent): Promise<void> => {
    const traceId = typeof event.traceId === 'string' ? event.traceId.trim() : '';
    const generationId = typeof event.generationId === 'string' ? event.generationId.trim() : '';
    if (!traceId || !generationId) return;

    try {
      const deps = await getDeps();
      if (!deps.isEnabled()) return;

      deps.getExporter().recordSignal({
        traceId,
        generationId,
        timestampMs: Number.isFinite(event.timestampMs) ? Math.floor(event.timestampMs) : Date.now(),
        level: event.level,
        message: event.message,
        ...(event.code ? { code: event.code } : {}),
        ...(event.stack ? { stack: event.stack } : {}),
        ...(event.metadata ? { metadata: event.metadata } : {})
      } as any);
    } catch (error: any) {
      options.logger.warning?.('signals.tool_failure_report_failed', {
        error: error?.message ?? String(error)
      });
    }
  };
}

