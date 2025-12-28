export function monotonicNowNs(): bigint {
  return process.hrtime.bigint();
}

export function monotonicElapsedMs(startNs: bigint, endNs: bigint = monotonicNowNs()): number {
  const deltaNs = endNs - startNs;
  if (deltaNs <= 0n) return 0;
  return Number(deltaNs / 1_000_000n);
}
