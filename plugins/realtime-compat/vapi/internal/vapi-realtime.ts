import type { IRealtimeCompat } from '../../../../kernel/index.js';

export default class VapiRealtimeCompat implements IRealtimeCompat {
  async createSession(options: Parameters<IRealtimeCompat['createSession']>[0]) {
    const { createVapiRealtimeCompatSession } = await import('./session.js');
    return createVapiRealtimeCompatSession(options);
  }
}

