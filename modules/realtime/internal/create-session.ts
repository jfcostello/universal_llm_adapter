import type {
  IRealtimeCompat,
  ProcessRouteManifest,
  ProviderManifest,
  RealtimeCompatSession,
  RealtimeSessionSpec,
  UnifiedTool
} from '../../kernel/index.js';
import type { RealtimeSession } from './realtime-session.js';
import { createRealtimeSessionController } from './realtime-session.js';

export interface RealtimeRegistryLike {
  getProvider: (id: string) => Promise<ProviderManifest>;
  getRealtimeCompat: (kind: string) => Promise<IRealtimeCompat>;
  getTools: (names: string[]) => Promise<UnifiedTool[]>;
  getProcessRoutes: () => Promise<ProcessRouteManifest[]>;
}

export async function createRealtimeSession(
  registry: RealtimeRegistryLike,
  spec: RealtimeSessionSpec
): Promise<RealtimeSession> {
  const provider = await registry.getProvider(spec.provider);
  const realtime = provider.realtime;
  if (!realtime?.compat) {
    throw new Error(`Provider '${provider.id}' does not declare realtime configuration`);
  }

  const compat = await registry.getRealtimeCompat(realtime.compat);
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
