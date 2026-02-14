export type IsAbortLikeErrorOptions = {
  includeMessage?: boolean;
};

export function createAbortError(message = 'Operation aborted'): Error {
  const error = new Error(message);
  (error as any).name = 'AbortError';
  (error as any).code = 'aborted';
  return error;
}

export function isAbortLikeError(error: unknown, options: IsAbortLikeErrorOptions = {}): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const name = String((error as any).name ?? '');
  const code = String((error as any).code ?? '');

  if (['AbortError', 'CanceledError'].includes(name)) return true;
  if (['aborted', 'ABORT_ERR', 'ERR_CANCELED'].includes(code)) return true;

  if (options.includeMessage) {
    const message = String((error as any).message ?? '').toLowerCase();
    if (['aborted', 'canceled', 'cancelled'].some(token => message.includes(token))) return true;
  }

  return false;
}

