export { createSignalsDeps } from './internal/signals/index.js';
export { reportSignal } from './internal/signals/index.js';

export type { SignalEvent, SignalLevel, SignalsDeps, SignalsRecordResult, SignalsSpec, SignalsTargetSpec } from '../../kernel/index.js';
export { getNoopSignalsDeps, resolveSignalsDeps } from '../../kernel/index.js';

export type { SignalEventInput } from './internal/signals/internal/report.js';
