import type { VoiceMediaWsLike } from './types.js';

export function approxBytesFromBase64(base64: string): number {
  const len = Math.max(0, base64.length);
  return Math.floor((len * 3) / 4);
}

export function ensureSendable(ws: VoiceMediaWsLike): void {
  const state = ws.readyState;
  // WebSocket.OPEN is 1 in `ws`, but we avoid depending on the library.
  if (state !== undefined && state !== 1) {
    throw new Error('WebSocket not open');
  }
}

export function safeClose(ws: VoiceMediaWsLike, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {}
}
