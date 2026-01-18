export function estimateBase64Bytes(value: string): number {
  const text = typeof value === 'string' ? value : '';
  const len = text.length;
  if (len === 0) return 0;
  let padding = 0;
  if (text.endsWith('==')) padding = 2;
  else if (text.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}
