import { describe, expect, test } from '@jest/globals';

import { handle } from '@/plugins/modules/noop-terminal/index.ts';

describe('plugins/modules/noop-terminal', () => {
  test('returns success payload', async () => {
    await expect(
      handle({
        toolName: 'noop.terminal',
        args: { any: 'value' }
      } as any)
    ).resolves.toEqual({ result: { ok: true } });
  });
});
