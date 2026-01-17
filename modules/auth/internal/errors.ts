import type { AuthErrorLike } from '../index.js';

function normalizeRealm(value: unknown): string {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : 'llm-adapter';
}

export class AuthError extends Error implements AuthErrorLike {
  statusCode: number;
  code: string;
  headers?: Record<string, string>;

  constructor(options: {
    message: string;
    statusCode: number;
    code: string;
    headers?: Record<string, string>;
  }) {
    super(options.message);
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.headers = options.headers;
  }
}

export function makeUnauthorizedError(options: { realm?: string }): AuthError {
  const realm = normalizeRealm(options.realm);
  return new AuthError({
    message: 'Unauthorized',
    statusCode: 401,
    code: 'unauthorized',
    headers: { 'WWW-Authenticate': `Bearer realm=\"${realm}\"` }
  });
}
