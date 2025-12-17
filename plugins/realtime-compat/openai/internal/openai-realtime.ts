import type { IRealtimeCompat } from '../../../../modules/kernel/index.js';
import { createOpenAIRealtimeCompatSession } from './session.js';

export default class OpenAIRealtimeCompat implements IRealtimeCompat {
  createSession(options: Parameters<IRealtimeCompat['createSession']>[0]) {
    return createOpenAIRealtimeCompatSession(options);
  }
}

