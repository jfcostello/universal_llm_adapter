function normalizeNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const normalized = normalizeNumber(value);
  const asInt = Number.isFinite(normalized as any) ? Math.floor(normalized as number) : Math.floor(fallback);
  return Math.min(max, Math.max(min, asInt));
}

export function clampRate(value: unknown, fallback: number): number {
  const normalized = normalizeNumber(value);
  const asNum = Number.isFinite(normalized as any) ? (normalized as number) : fallback;
  return Math.min(1, Math.max(0, asNum));
}

