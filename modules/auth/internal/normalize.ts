export function normalizeSeparator(value: unknown, fallback: string): string {
  const raw = String(value ?? '');
  return raw ? raw : fallback;
}
