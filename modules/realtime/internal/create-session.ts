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

  const logger = await (async () => {
    try {
      const { getRealtimeLogger } = await import('../../logging/index.js');
      return getRealtimeLogger(spec.metadata?.correlationId as any);
    } catch {
      return undefined;
    }
  })();

  const observabilityDefaults = getDefaults().observability;
  const observabilityEnabled = spec.observability?.enabled ?? observabilityDefaults.enabled;
  const observability = observabilityEnabled
    ? await (async () => {
        try {
          const { createObservabilityRuntime } = await import('../../observability/index.js');

          let logger: any = undefined;
          try {
            const { getLogger } = await import('../../logging/index.js');
            logger = getLogger(spec.metadata?.correlationId as any);
          } catch {
            // best-effort
          }

          return await createObservabilityRuntime(registry as any, spec.observability, {
            metadata: spec.metadata,
            logger,
            // Realtime sessions commonly use correlationId/session metadata instead of batch ids.
            sessionIdFallback: 'correlation'
          });
        } catch {
          return undefined;
        }
      })()
    : undefined;

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
