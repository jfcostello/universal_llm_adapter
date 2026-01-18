export type { RealtimeSession, RealtimeSessionControllerOptions } from './internal/types.js';

import { RealtimeSessionController } from './internal/controller.js';
import type { RealtimeSession, RealtimeSessionControllerOptions } from './internal/types.js';

export function createRealtimeSessionController(options: RealtimeSessionControllerOptions): RealtimeSession {
  return new RealtimeSessionController(options);
}
