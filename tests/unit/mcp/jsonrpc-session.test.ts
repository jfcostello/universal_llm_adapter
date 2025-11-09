import { PassThrough, Writable } from 'stream';
import { jest } from '@jest/globals';
import { JSONRPCSession } from '@/mcp/mcp-client.ts';

describe('mcp/JSONRPCSession', () => {
  test('resolves and rejects pending requests based on responses', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const session = new JSONRPCSession(input, output);

    const success = session.request('ok');
    const failure = session.request('fail');

    input.write(JSON.stringify({ id: 1, result: { status: 'done' } }) + '\n');
    input.write(JSON.stringify({ id: 2, error: { message: 'nope' } }) + '\n');

    await expect(success).resolves.toEqual({ status: 'done' });
    await expect(failure).rejects.toThrow('nope');
  });

  test('emits notifications for server messages', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const session = new JSONRPCSession(input, output);

    const handler = jest.fn();
    session.on('notification', handler);

    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }) + '\n');

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ method: 'ping' }));
  });

  test('ignores invalid JSON lines without crashing', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const session = new JSONRPCSession(input, output);

    input.write('\n');
    input.write('this-is-not-json\n');
    input.write(JSON.stringify({ id: 1, result: { ok: true } }) + '\n');

    const result = session.request('test');
    input.write(JSON.stringify({ id: 1, result: { ok: true } }) + '\n');
    await expect(result).resolves.toEqual({ ok: true });
  });

  test('rejects requests on timeout and write errors', async () => {
    jest.useFakeTimers();

    const input = new PassThrough();
    const failingWriter = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('write-fail'));
      }
    });
    failingWriter.on('error', () => {});

    const session = new JSONRPCSession(input, failingWriter as any);

    await expect(session.request('write')).rejects.toThrow('write-fail');

    const output = new PassThrough();
    const sessionWithTimeout = new JSONRPCSession(input, output);
    const pending = sessionWithTimeout.request('timeout');

    jest.advanceTimersByTime(30001);
    await expect(pending).rejects.toThrow('Request timeout: timeout');

    jest.useRealTimers();
  });
});
