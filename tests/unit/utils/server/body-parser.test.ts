import { Readable } from 'stream';
import { readJsonBody } from '@/utils/server/internal/body-parser.ts';

function makeReq(body: string): any {
  const req = new Readable({
    read() {
      this.push(body);
      this.push(null);
    }
  }) as any;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

describe('utils/server readJsonBody', () => {
  test('parses valid JSON body', async () => {
    const req = makeReq(JSON.stringify({ ok: true, n: 1 }));
    await expect(readJsonBody(req)).resolves.toEqual({ ok: true, n: 1 });
  });

  test('throws on invalid JSON', async () => {
    const req = makeReq('{bad json}');
    await expect(readJsonBody(req)).rejects.toThrow('Invalid JSON body');
  });

  test('returns empty object for empty body', async () => {
    const req = makeReq('');
    await expect(readJsonBody(req)).resolves.toEqual({});
  });
});
