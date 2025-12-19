import type { IRealtimeCompat, RealtimeCompatSession, RealtimeSessionSpec } from '../../../../modules/kernel/index.js';

import { createOpenAIRealtimeCompatSessionWithTransport, resolveOpenAIWsUrl } from './session-core.js';
import { createWsTransport } from './transport/ws.js';

export function createOpenAIRealtimeWsCompatSession(
  options: Parameters<IRealtimeCompat['createSession']>[0]
): RealtimeCompatSession {
  const provider = options.provider;
  const spec = options.spec as RealtimeSessionSpec;

  const url = resolveOpenAIWsUrl({ provider, spec });

  const headers = provider.endpoint?.headers ?? {};
  const transport = createWsTransport({ url, headers });
  return createOpenAIRealtimeCompatSessionWithTransport(options, transport);
}
