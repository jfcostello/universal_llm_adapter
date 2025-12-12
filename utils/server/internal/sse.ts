import type http from 'http';

export function writeSseEvent(res: http.ServerResponse, event: unknown): void {
  const payload = typeof event === 'string' ? event : JSON.stringify(event);
  res.write(`data: ${payload}\n\n`);
}

export async function writeSseEventWithBackpressure(
  res: http.ServerResponse,
  event: unknown
): Promise<void> {
  const payload = typeof event === 'string' ? event : JSON.stringify(event);
  const ok = res.write(`data: ${payload}\n\n`);
  if (!ok) {
    await new Promise<void>(resolve => res.once('drain', resolve));
  }
}
