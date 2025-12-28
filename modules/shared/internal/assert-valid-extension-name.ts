export function assertValidExtensionName(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new Error('Invalid extension name: empty');
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(raw)) {
    throw new Error(`Invalid extension name: '${raw}'`);
  }
  return raw;
}
