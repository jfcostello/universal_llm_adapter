import type http from 'http';

export function writeSseEvent(res: http.ServerResponse, event: unknown): void {
  const payload = typeof event === 'string' ? event : JSON.stringify(event);
  res.write(`data: ${payload}\n\n`);
}

