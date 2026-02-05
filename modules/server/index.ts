export { mapErrorToHttp } from './internal/transport/error-mapper.js';
export {
  assertValidSpec,
  assertValidVectorSpec,
  assertValidEmbeddingSpec,
  assertValidTelemetrySubmission
} from './internal/transport/spec-validator.js';

// Public server helpers intended for use by extensions.
export { readJsonBody } from './internal/transport/body-parser.js';
export { writeHttpUpgradeResponse } from './internal/transport/upgrade-router.js';
export type { AuthConfig, AuthContext, AuthErrorLike, Authenticator } from '../auth/index.js';
export { createAuthenticator } from '../auth/index.js';
export type { CorsConfig } from './internal/security/cors.js';
export { applyCors } from './internal/security/cors.js';
export { applySecurityHeaders } from './internal/security/security-headers.js';
export type { RateLimitConfig } from './internal/security/rate-limiter.js';
export { createRateLimiter, getClientIp } from './internal/security/rate-limiter.js';

export type {
  ServerCorsOptions,
  ServerDependencies,
  ServerOptions,
  ServerPolicyOptions,
  ServerRateLimitOptions,
  RunningServer
} from './internal/server-types.js';

export { createServerHandlerWithDefaults } from './internal/create-handler-with-defaults.js';
export { createServer } from './internal/create-server.js';

export { createAudioRateLimiter } from './internal/transport/audio-rate-limiter.js';

export type { LLMCallSpec, LLMStreamEvent } from '../../kernel/index.js';
