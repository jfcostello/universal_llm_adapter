export function parseNonNegativeInt(value: unknown, defaultValue: number): number {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : defaultValue;
  }
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : defaultValue;
}
