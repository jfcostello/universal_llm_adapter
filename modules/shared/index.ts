export { normalizeFlag } from './internal/normalize-flag.js';
export { assertValidExtensionName } from './internal/assert-valid-extension-name.js';
export { readTrimmedStringProperty } from './internal/read-trimmed-string-property.js';
export { makeHttpError } from './internal/make-http-error.js';
export { deriveObservabilityModel } from './internal/derive-observability-model.js';

export type { Deferred } from './internal/deferred.js';
export { createDeferred } from './internal/deferred.js';

export { sleep, sleepWithSignal } from './internal/sleep.js';

export { monotonicNowNs, monotonicElapsedMs } from './internal/monotonic.js';

export { calculateBackoffDelay } from './internal/calculate-backoff-delay.js';

export { truncateUtf8Bytes } from './internal/serialization.js';

export type { SafeJsonStringifyOptions, FlattenPrimitiveStringsOptions } from './internal/serialization.js';
export { safeJsonStringify, flattenPrimitiveStrings } from './internal/serialization.js';
