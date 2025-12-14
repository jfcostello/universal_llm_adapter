import { ProviderExecutionError, ToolExecutionError } from '@/core/errors.ts';
import { mapErrorToHttp } from '@/modules/server/internal/transport/error-mapper.ts';

describe('utils/server mapErrorToHttp', () => {
  test('maps validation errors to 400', () => {
    const err: any = new Error('Spec validation failed');
    err.statusCode = 400;
    err.code = 'validation_error';
    const mapped = mapErrorToHttp(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe('validation_error');
  });

  test('infers validation_error from 400 message when no code set', () => {
    const err: any = new Error('validation failed');
    err.statusCode = 400;
    const mapped = mapErrorToHttp(err);
    expect(mapped.body.error.code).toBe('validation_error');
  });

  test('infers invalid_json from 400 message when no code set', () => {
    const err: any = new Error('bad json');
    err.statusCode = 400;
    const mapped = mapErrorToHttp(err);
    expect(mapped.body.error.code).toBe('invalid_json');
  });

  test('infers bad_request from generic 400', () => {
    const err: any = new Error('nope');
    err.statusCode = 400;
    const mapped = mapErrorToHttp(err);
    expect(mapped.body.error.code).toBe('bad_request');
  });

  test('infers bad_request when 400 has no message', () => {
    const err: any = { statusCode: 400 };
    const mapped = mapErrorToHttp(err);
    expect(mapped.body.error.code).toBe('bad_request');
  });

  test('maps payload too large to 413', () => {
    const err: any = new Error('Request body too large');
    err.statusCode = 413;
    const mapped = mapErrorToHttp(err);
    expect(mapped.status).toBe(413);
    expect(mapped.body.error.code).toBe('payload_too_large');
  });

  test('maps rate limit provider errors to 429', () => {
    const err = new ProviderExecutionError('p', 'rate limited', 429, true);
    const mapped = mapErrorToHttp(err);
    expect(mapped.status).toBe(429);
    expect(mapped.body.error.code).toBe('rate_limited');
  });

  test('maps non-rate-limit provider errors to 502', () => {
    const err = new ProviderExecutionError('p', 'boom', 500, false);
    const mapped = mapErrorToHttp(err);
    expect(mapped.status).toBe(502);
  });

  test('maps tool errors to 502', () => {
    const err: any = new ToolExecutionError('tool fail');
    const mapped = mapErrorToHttp(err);
    expect(mapped.status).toBe(502);
  });

  test('maps unsupported media type to 415', () => {
    const err: any = new Error('bad type');
    err.statusCode = 415;
    const mapped = mapErrorToHttp(err);
    expect(mapped.status).toBe(415);
    expect(mapped.body.error.code).toBe('unsupported_media_type');
  });

  test('maps body read timeout to 408', () => {
    const err: any = new Error('read timed out');
    err.statusCode = 408;
    const mapped = mapErrorToHttp(err);
    expect(mapped.status).toBe(408);
    expect(mapped.body.error.code).toBe('body_read_timeout');
  });

  test('maps queue timeout to 503 queue_timeout', () => {
    const err: any = new Error('queue wait timed out');
    err.statusCode = 503;
    err.code = 'queue_timeout';
    const mapped = mapErrorToHttp(err);
    expect(mapped.status).toBe(503);
    expect(mapped.body.error.code).toBe('queue_timeout');
  });

  test('maps generic 503 to server_busy', () => {
    const err: any = new Error('busy');
    err.statusCode = 503;
    const mapped = mapErrorToHttp(err);
    expect(mapped.body.error.code).toBe('server_busy');
  });

  test('maps timeout to 504', () => {
    const err: any = new Error('Request timed out');
    err.statusCode = 504;
    const mapped = mapErrorToHttp(err);
    expect(mapped.status).toBe(504);
    expect(mapped.body.error.code).toBe('timeout');
  });
});
