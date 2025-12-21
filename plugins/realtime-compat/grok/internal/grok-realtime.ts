import type { IRealtimeCompat, RealtimeCompatSession, RealtimeSessionSpec } from '../../../../modules/kernel/index.js';

import { createGrokRealtimeWsCompatSession } from './session-ws.js';

export default class GrokRealtimeCompat implements IRealtimeCompat {
  async createSession(options: Parameters<IRealtimeCompat['createSession']>[0]): Promise<RealtimeCompatSession> {
    const spec = options.spec as RealtimeSessionSpec;
    const transportType = spec.transport?.type ?? 'ws';
    if (transportType !== 'ws') {
      throw new Error(`Realtime transport not supported for provider '${options.provider.id}': ${transportType}`);
    }
    return createGrokRealtimeWsCompatSession(options);
  }
}

