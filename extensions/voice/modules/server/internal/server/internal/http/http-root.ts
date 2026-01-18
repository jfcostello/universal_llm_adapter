import type http from 'http';

import type { VoiceServerContext } from '../core/context.js';
import { writeJson } from './utils-http.js';

export async function handleVoiceRoot(
  _ctx: VoiceServerContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname !== '/voice' && url.pathname !== '/voice/') return false;
  writeJson(res, 200, { ok: true });
  return true;
}
