import { RetryPolicy, DEFAULT_RATE_LIMIT_DELAYS } from './retry-policy.js';
import { AdapterLogger } from '../../core/logging.js';
import { ProviderExecutionError } from '../../core/errors.js';

export interface RetrySequenceItem {
  provider: string;
  model: string;
  fn: () => Promise<any>;
}

export async function withRetries<T>(
  sequence: RetrySequenceItem[],
  policy?: RetryPolicy,
  logger?: AdapterLogger
): Promise<T> {
  const retryPolicy = policy || {
    maxAttempts: 3,
    baseDelayMs: 250,
    multiplier: 2.0,
    rateLimitDelays: DEFAULT_RATE_LIMIT_DELAYS
  };
  
  let lastError: Error | undefined;
  
  for (const item of sequence) {
    let delay = retryPolicy.baseDelayMs / 1000;
    let totalAttempts = 0;
    let normalFailures = 0;
    let rateLimitAttempts = 0;
    const rateLimitSchedule = retryPolicy.rateLimitDelays || DEFAULT_RATE_LIMIT_DELAYS;
    
    while (true) {
      totalAttempts++;
      
      try {
        const result = await item.fn();
        return result;
      } catch (error: any) {
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
            
            await sleep(nextDelay * 1000);
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
          
          await sleep(nextDelay * 1000);
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}