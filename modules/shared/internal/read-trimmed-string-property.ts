export function readTrimmedStringProperty(record: unknown, key: string): string | undefined {
  const value = (record as any)?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
