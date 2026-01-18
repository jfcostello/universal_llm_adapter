import { makeHttpError } from '../../../../../../modules/shared/index.js';

export function makeProviderConfigError(message: string): Error {
  return makeHttpError({ message, statusCode: 500, code: 'provider_config_error' });
}

export function makeUnauthorizedError(message: string): Error {
  return makeHttpError({ message, statusCode: 401, code: 'unauthorized' });
}

export function normalizePlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

export function stripToSingleLine(value: string): string {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s\s+/g, ' ')
    .trim();
}

