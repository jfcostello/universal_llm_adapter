export type PathSegment = string | number;

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function normalizePath(path: string | PathSegment[]): PathSegment[] {
  if (Array.isArray(path)) {
    return path;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed
    .split('.')
    .filter(Boolean)
    .map((segment) => {
      // Support array indexing in string paths, e.g. "choices.0.message".
      if (/^(0|[1-9]\d*)$/.test(segment)) {
        return Number(segment);
      }
      return segment;
    });
}

export function getByPath<T = unknown>(
  value: unknown,
  path: string | PathSegment[],
  options?: { defaultValue?: T }
): T | undefined {
  const segments = normalizePath(path);

  let current: unknown = value;
  for (const segment of segments) {
    if (!isObjectLike(current)) {
      return options?.defaultValue;
    }

    const next =
      typeof segment === 'number'
        ? Array.isArray(current)
          ? current[segment]
          : (current as any)[segment]
        : (current as any)[segment];

    if (next === undefined) {
      return options?.defaultValue;
    }

    current = next;
  }

  return current as T;
}

export function safeJsonParse<T = unknown>(
  input: string | null | undefined,
  fallback?: T
): T | undefined {
  if (input == null) {
    return fallback;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return fallback;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
}

