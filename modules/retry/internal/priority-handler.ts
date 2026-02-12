import { RetryPolicy, createDefaultRetryPolicy } from './retry-policy.js';
import { getDefaults } from '../../../kernel/index.js';
import type { AdapterLogger } from '../../../kernel/index.js';
import { sleepWithSignal } from '../../shared/index.js';

export interface RetrySequenceItem {
  provider: string;
  model: string;
  fn: () => Promise<any>;
}

export interface RetryExecutionOptions {
  signal?: AbortSignal;
  isAbortLikeError?: (error: unknown) => boolean;
}

function createAbortError(message = 'Operation aborted'): Error {
  const error = new Error(message);
  (error as any).name = 'AbortError';
  (error as any).code = 'aborted';
  return error;
}

function defaultIsAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const name = String((error as any).name ?? '');
  const code = String((error as any).code ?? '');

  if (['AbortError', 'CanceledError'].includes(name)) return true;
  if (['aborted', 'ABORT_ERR', 'ERR_CANCELED'].includes(code)) return true;
  return false;
}

export async function withRetries<T>(
  sequence: RetrySequenceItem[],
  policy?: RetryPolicy,
  logger?: AdapterLogger,
  options: RetryExecutionOptions = {}
): Promise<T> {
  const retryPolicy = policy || createDefaultRetryPolicy();
  const isAbortLikeError =
    options.isAbortLikeError ||
    (options.signal ? defaultIsAbortLikeError : (() => false));
  
  let lastError: Error | undefined;
  
  for (const item of sequence) {
    let delay = retryPolicy.baseDelayMs / 1000;
    let totalAttempts = 0;
    let normalFailures = 0;
    let rateLimitAttempts = 0;
    const rateLimitSchedule = retryPolicy.rateLimitDelays || getDefaults().retry.rateLimitDelays;
    
    while (true) {
      if (options.signal?.aborted) {
        throw createAbortError();
      }
      totalAttempts++;
      
      try {
        const result = await item.fn();
        return result;
      } catch (error: any) {
        if (options.signal?.aborted) {
          throw createAbortError();
        }
        if (isAbortLikeError(error)) {
          throw error;
        }

        lastError = error;
        const isRateLimit = error.isRateLimit || false;
        const retryType = isRateLimit ? 'rate_limit' : 'standard';
        
        if (isRateLimit) {
          const retryTotal = rateLimitSchedule.length;
          
          if (rateLimitAttempts < retryTotal) {
            const nextDelay = rateLimitSchedule[rateLimitAttempts];
            
            if (logger) {
              logger.warning('Provider attempt failed', {
                provider: item.provider,
                model: item.model,
                attempt: totalAttempts,
                rateLimited: true,
                retryType,
                retryScheduled: true,
                retryNumber: rateLimitAttempts + 1,
                retryTotal,
                nextDelaySeconds: nextDelay,
                error: error.message
              });
            }
            
            const slept = await sleepWithSignal(nextDelay * 1000, options.signal);
            if (!slept) {
              throw createAbortError();
            }
            rateLimitAttempts++;
            continue;
          }
          
          if (logger) {
            logger.warning('Provider attempt failed - rate limit retries exhausted', {
              provider: item.provider,
              model: item.model,
              attempt: totalAttempts,
              rateLimited: true,
              retryType,
              retryScheduled: false,
              error: error.message
            });
          }
          break;
        }
        
        normalFailures++;
        const retryTotal = Math.max(retryPolicy.maxAttempts - 1, 0);
        
        if (normalFailures < retryPolicy.maxAttempts) {
          const nextDelay = delay;
          
          if (logger) {
            logger.warning('Provider attempt failed', {
              provider: item.provider,
              model: item.model,
              attempt: totalAttempts,
              rateLimited: false,
              retryType,
              retryScheduled: true,
              retryNumber: normalFailures,
              retryTotal,
              nextDelaySeconds: nextDelay,
              error: error.message
            });
          }
          
          const slept = await sleepWithSignal(nextDelay * 1000, options.signal);
          if (!slept) {
            throw createAbortError();
          }
          delay *= retryPolicy.multiplier;
          continue;
        }
        
        if (logger) {
          logger.warning('Provider attempt failed - retries exhausted', {
            provider: item.provider,
            model: item.model,
            attempt: totalAttempts,
            rateLimited: false,
            retryType,
            retryScheduled: false,
            error: error.message
          });
        }
        break;
      }
    }
  }
  
  if (lastError) {
    throw lastError;
  }
  
  throw new Error('Retry sequence empty');
}
