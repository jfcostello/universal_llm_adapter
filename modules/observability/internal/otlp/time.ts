export type OtlpHrTime = [number, number];

export function isoToOtlpHrTime(iso: string): OtlpHrTime {
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return [0, 0];

  const seconds = Math.floor(ms / 1000);
  const nanos = Math.floor((ms - seconds * 1000) * 1e6);
  return [seconds, nanos];
}

