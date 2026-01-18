import type http from 'http';

import type { HandlerContext } from '../context.js';
import { writeJson } from '../response.js';
import { assertAuthorizedAndRateLimited } from '../security-helpers.js';

export async function handleExtensionsList(
  ctx: HandlerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  await assertAuthorizedAndRateLimited(ctx, req);
  const { listExtensions } = await import('../../../../../extensions/index.js');
  const results = listExtensions().map(item => ({
    name: item.name,
    kind: item.kind,
    root: item.root
  }));
  writeJson(res, 200, { type: 'response', data: results });
}
