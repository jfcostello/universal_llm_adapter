export function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base: Record<string, any>, overlay: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    if (key in merged && isPlainObject(merged[key]) && isPlainObject(value)) {
      merged[key] = deepMerge(merged[key], value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

