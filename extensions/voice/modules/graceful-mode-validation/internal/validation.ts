import { makeHttpError, normalizeFlag } from '../../../../../modules/shared/index.js';

/**
 * Valid modes for graceful call ending.
 */
export type GracefulEndMode = 'immediate' | 'after_assistant_audio' | 'after_playback';

/**
 * Valid modes for graceful call transfer.
 */
export type GracefulTransferMode = 'immediate' | 'after_playback';

/**
 * Validates and returns an end mode, throwing on invalid input.
 * @param raw - Raw input value (may be undefined/null/empty)
 * @param defaultMode - Default mode when raw is empty
 * @returns The validated mode
 * @throws HttpError with 400 status if mode is invalid
 */
export function validateEndMode(
  raw: string | undefined | null,
  defaultMode: GracefulEndMode
): GracefulEndMode {
  const trimmed = raw !== undefined && raw !== null ? String(raw).trim() : '';
  const value = trimmed || defaultMode;

  if (value === 'immediate' || value === 'after_assistant_audio' || value === 'after_playback') {
    return value;
  }

  throw makeHttpError({ message: 'Invalid mode', statusCode: 400, code: 'validation_error' });
}

/**
 * Validates and returns a transfer mode, throwing on invalid input.
 * @param raw - Raw input value (may be undefined/null/empty)
 * @param defaultMode - Default mode when raw is empty
 * @returns The validated mode
 * @throws HttpError with 400 status if mode is invalid
 */
export function validateTransferMode(
  raw: string | undefined | null,
  defaultMode: GracefulTransferMode
): GracefulTransferMode {
  const trimmed = raw !== undefined && raw !== null ? String(raw).trim() : '';
  const value = trimmed || defaultMode;

  if (value === 'immediate' || value === 'after_playback') {
    return value;
  }

  throw makeHttpError({ message: 'Invalid mode', statusCode: 400, code: 'validation_error' });
}

/**
 * Validates and returns maxWaitMs, throwing on invalid input.
 * @param raw - Raw input value (may be undefined/null/empty)
 * @param defaultValue - Default value when raw is empty
 * @param limit - Optional maximum limit
 * @returns The validated maxWaitMs value
 * @throws HttpError with 400 status if value is invalid
 */
export function validateMaxWaitMs(
  raw: unknown,
  defaultValue: number,
  limit?: number
): number {
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }

  const n = Number(raw);
  const out = Math.floor(n);

  if (!Number.isFinite(n) || out < 0) {
    throw makeHttpError({
      message: limit !== undefined ? `Invalid maxWaitMs (must be 0-${limit})` : 'Invalid maxWaitMs',
      statusCode: 400,
      code: 'validation_error'
    });
  }

  if (limit !== undefined && out > limit) {
    throw makeHttpError({
      message: `Invalid maxWaitMs (must be 0-${limit})`,
      statusCode: 400,
      code: 'validation_error'
    });
  }

  return out;
}

/**
 * Validates and returns cancelOnUserSpeech flag, throwing on invalid input.
 * For CLI use - validates string input from command line options.
 * @param raw - Raw input value from CLI (may be undefined/null/empty string)
 * @returns The validated boolean value, or undefined if raw is empty (to skip setting)
 * @throws HttpError with 400 status if value is invalid
 */
export function validateCancelOnUserSpeechCli(
  raw: string | undefined | null
): boolean | undefined {
  if (raw === undefined || raw === null) {
    return undefined; // Not provided, don't include in request
  }

  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed) {
    return undefined; // Empty string, don't include in request
  }

  const truthy = ['true', '1', 'yes', 'y', 'on'];
  const falsy = ['false', '0', 'no', 'n', 'off'];

  if (truthy.includes(trimmed)) {
    return true;
  }
  if (falsy.includes(trimmed)) {
    return false;
  }

  throw makeHttpError({ message: 'Invalid cancelOnUserSpeech', statusCode: 400, code: 'validation_error' });
}

/**
 * Validates cancelOnUserSpeech for server use - uses normalizeFlag directly.
 * @param raw - Raw input value from request body
 * @param defaultValue - Default value when raw is undefined
 * @returns The validated boolean value
 */
export function validateCancelOnUserSpeechServer(
  raw: unknown,
  defaultValue: boolean
): boolean {
  return normalizeFlag(raw, defaultValue);
}
