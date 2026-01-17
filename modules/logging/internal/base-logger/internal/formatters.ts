import * as winston from 'winston';
import type { TransformableInfo } from 'logform';

import { createIsoTimestamp } from './config.js';

export function hasCorrelationId(correlationId?: string | string[]): boolean {
  if (!correlationId) return false;
  if (Array.isArray(correlationId)) return correlationId.length > 0;
  return true;
}

export function readCorrelationId(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value as string[];
  return undefined;
}

export function createAdapterFileFormat(
  correlationId: string | string[] | undefined,
  jsonReplacer: ((key: string, value: any) => any) | undefined
): winston.Logform.Format {
  return winston.format.printf((info: TransformableInfo) => {
    const { level, message, ...data } = info as TransformableInfo & {
      level: unknown;
      message?: unknown;
    };
    const timestamp = createIsoTimestamp();
    const logLevel = typeof level === 'string' ? level : String(level);
    const resolvedMessage =
      typeof message === 'string' ? message : JSON.stringify(message ?? '');
    const logObj: Record<string, unknown> = { level: logLevel, message: resolvedMessage };
    if (hasCorrelationId(correlationId)) logObj.correlationId = correlationId;
    if (Object.keys(data).length > 0) {
      Object.assign(logObj, data);
    }
    return `[${timestamp}]: ${JSON.stringify(logObj, jsonReplacer)}`;
  });
}

