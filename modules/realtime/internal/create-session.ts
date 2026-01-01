import type {
  IRealtimeCompat,
  ProcessRouteManifest,
  RealtimeProviderManifest,
  RealtimeCompatSession,
  RealtimeSessionSpec,
  UnifiedTool
} from '../../../kernel/index.js';
import { getDefaults } from '../../../kernel/index.js';
import type { RealtimeSession } from './realtime-session.js';
import { createRealtimeSessionController } from './realtime-session.js';

export interface RealtimeRegistryLike {
  getRealtimeProvider: (id: string) => Promise<RealtimeProviderManifest>;
  getRealtimeCompat: (kind: string) => Promise<IRealtimeCompat>;
  getTools: (names: string[]) => Promise<UnifiedTool[]>;
  getProcessRoutes: () => Promise<ProcessRouteManifest[]>;
}

export async function createRealtimeSession(
  registry: RealtimeRegistryLike,
  spec: RealtimeSessionSpec
): Promise<RealtimeSession> {
  const provider = await registry.getRealtimeProvider(spec.provider);
  if (!provider?.compat) {
    throw new Error(`Realtime provider '${provider?.id ?? spec.provider}' does not declare compat configuration`);
  }

  const compat = await registry.getRealtimeCompat(provider.compat);
  const tools = spec.functionToolNames && spec.functionToolNames.length > 0
    ? await registry.getTools(spec.functionToolNames)
    : undefined;

  const compatSession = await Promise.resolve(
    compat.createSession({ provider, spec, tools }) as unknown as RealtimeCompatSession
  );

  const { logger, adapterLogger } = await (async () => {
    try {
      const logging = await import('../../logging/index.js');
      return {
        logger: typeof (logging as any).getRealtimeLogger === 'function'
          ? (logging as any).getRealtimeLogger(spec.metadata?.correlationId as any)
          : undefined,
        adapterLogger: typeof (logging as any).getLogger === 'function'
          ? (logging as any).getLogger(spec.metadata?.correlationId as any)
          : undefined
      };
    } catch {
      return { logger: undefined, adapterLogger: undefined };
    }
  })();

  const observabilityDefaults = getDefaults().observability;
  const observabilityEnabled = spec.observability?.enabled ?? observabilityDefaults.enabled;
  const observability = observabilityEnabled
    ? await (async () => {
        try {
          const { createObservabilityRuntime } = await import('../../observability/index.js');

          return await createObservabilityRuntime(registry as any, spec.observability, {
            metadata: spec.metadata,
            logger: adapterLogger,
            // Realtime sessions commonly use correlationId/session metadata instead of batch ids.
            sessionIdFallback: 'correlation'
          });
        } catch {
          return undefined;
        }
      })()
    : undefined;

  if (
    spec.observability?.enabled === true &&
    !observability &&
    (spec.observability.sampleRate ?? observabilityDefaults.sampleRate) >= 1
  ) {
    try {
      (logger ?? adapterLogger)?.warning?.('realtime.observability.unavailable', {
        message: 'Observability is enabled for this realtime session but could not be initialized'
      });
    } catch {
      // best-effort
    }
  }

  return createRealtimeSessionController({
    registry,
    provider,
    spec,
    tools,
    compatSession,
    ...(logger ? { logger } : {}),
    ...(observability ? { observability } : {})
  });
}
