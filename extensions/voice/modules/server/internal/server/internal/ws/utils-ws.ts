import { isPlainObject } from '../../../../../../../../modules/shared/index.js';

export function findDeepStringValueByKey(options: { value: unknown; key: string; maxDepth: number }): string | undefined {
  const keyLower = String(options.key).toLowerCase();
  const maxDepth = Math.max(0, Math.floor(options.maxDepth));

  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > maxDepth) return undefined;
    if (!value || typeof value !== 'object') return undefined;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return undefined;
    }

    for (const [k, v] of Object.entries(value as any)) {
      if (String(k).toLowerCase() === keyLower) {
        if (typeof v === 'string') {
          const trimmed = v.trim();
          if (trimmed) return trimmed;
        }
      }
      const found = visit(v, depth + 1);
      if (found) return found;
    }

    return undefined;
  };

  return visit(options.value, 0);
}

export function tryParseWsMessageJson(data: any): any | undefined {
  try {
    const buf = Buffer.from(data as any);
    const text = buf.toString('utf-8');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function approxWsMessageBytes(data: any): number {
  return Buffer.byteLength(data as any);
}

export function asPlainObject(value: unknown): Record<string, any> | undefined {
  if (!isPlainObject(value)) return undefined;
  return value as Record<string, any>;
}
