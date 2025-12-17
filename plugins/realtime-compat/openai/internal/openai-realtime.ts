import type { IRealtimeCompat } from '../../../../modules/kernel/index.js';
import type { RealtimeSessionSpec } from '../../../../modules/kernel/index.js';

export default class OpenAIRealtimeCompat implements IRealtimeCompat {
  async createSession(options: Parameters<IRealtimeCompat['createSession']>[0]) {
    const spec = options.spec as RealtimeSessionSpec;
    const transportType = spec.transport?.type ?? 'ws';

    if (transportType === 'webrtc') {
      const { createOpenAIRealtimeWebrtcCompatSession } = await import('./session-webrtc.js');
      return createOpenAIRealtimeWebrtcCompatSession(options);
    }

    const { createOpenAIRealtimeWsCompatSession } = await import('./session-ws.js');
    return createOpenAIRealtimeWsCompatSession(options);
  }
}
