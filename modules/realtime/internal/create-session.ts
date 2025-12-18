import type {
  IRealtimeCompat,
  ProcessRouteManifest,
  RealtimeProviderManifest,
  RealtimeCompatSession,
  RealtimeSessionSpec,
  UnifiedTool
} from '../../kernel/index.js';
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

  return createRealtimeSessionController({
    registry,
    provider,
    spec,
    tools,
    compatSession
  });
}
