import type { JsonValue } from '../../../../kernel/index.js';

export type WsLike = {
  readyState: number;
  on: (event: string, cb: (...args: any[]) => void) => void;
  send: (data: any) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
};

export function resolveRealtimeUrl(options: { urlTemplate: string; model: string; query?: Record<string, string> }): string {
  const template = String(options.urlTemplate);
  const base = template.includes('{model}')
    ? template.replace('{model}', encodeURIComponent(options.model))
    : template;

  const url = new URL(base);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      url.searchParams.set(k, v.includes('{model}') ? v.replace('{model}', options.model) : v);
    }
  }
  return url.toString();
}

export function generateSessionId(): string {
  return `sess_local_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function send(ws: WsLike, msg: any): void {
  ws.send(JSON.stringify(msg));
}

export function ensureJsonObject(value: JsonValue): any {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return { output: value };
}

