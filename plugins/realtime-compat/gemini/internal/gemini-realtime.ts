import type { IRealtimeCompat } from '../../../../modules/kernel/index.js';
import { createGeminiRealtimeCompatSession } from './session.js';

export default class GeminiRealtimeCompat implements IRealtimeCompat {
  createSession(options: Parameters<IRealtimeCompat['createSession']>[0]) {
    return createGeminiRealtimeCompatSession(options);
  }
}

