import type { RealtimeSessionSpec } from '../../../../../kernel/index.js';

export const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 1000;
export const DEFAULT_ON_TIMEOUT: NonNullable<RealtimeSessionSpec['timeout']>['onTimeout'] = 'close';
