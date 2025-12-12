import { Readable } from 'stream';
import { readJsonBody } from '@/utils/server/internal/transport/body-parser.ts';

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

  test('throws 413 when body exceeds maxBytes', async () => {
    const req = makeReq(JSON.stringify({ text: 'this is too large' }));
    await expect(readJsonBody(req, { maxBytes: 5 })).rejects.toMatchObject({
      message: expect.stringContaining('Request body too large'),
      statusCode: 413
    });
  });

  test('throws on read timeout', async () => {
    const req = new Readable({
      read() {
        setTimeout(() => {
          this.push(JSON.stringify({ ok: true }));
          this.push(null);
        }, 30);
      }
    }) as any;
    req.headers = { 'content-type': 'application/json' };

    await expect(readJsonBody(req, { timeoutMs: 5 })).rejects.toMatchObject({
      message: expect.stringContaining('Request body read timed out'),
      statusCode: 408
    });
  });
});
