import { describe, expect, test } from '@jest/globals';
import {
  genericRedactHeaders,
  redactJsonCredentials,
  redactUrlCredentials,
  redactUrlQueryCredentials,
  redactUrlQueryParams,
  redactUrl
} from '@/modules/security/index.ts';

describe('utils/security/redaction', () => {
  test('genericRedactHeaders masks authorization and api keys', () => {
    const redacted = genericRedactHeaders({
      Authorization: 'Bearer sk-abcdef1234567890',
      'x-api-key': 'anthropic-key-1234',
      Other: 'value'
    });

    expect(redacted.Authorization).toBe('Bearer ***7890');
    expect(redacted['x-api-key']).toBe('***1234');
    expect(redacted.Other).toBe('value');
  });

  test('genericRedactHeaders handles missing headers gracefully', () => {
    const redacted = genericRedactHeaders({});
    expect(redacted).toEqual({});
  });

  test('redactUrlCredentials redacts basic-auth credentials', () => {
    expect(redactUrlCredentials('https://user:password@cloud.example.com')).toBe('https://***:***@cloud.example.com');
  });

  test('redactUrlCredentials leaves URLs without credentials unchanged', () => {
    expect(redactUrlCredentials('https://cloud.example.com')).toBe('https://cloud.example.com');
  });

  describe('redactUrlQueryCredentials / redactUrlQueryParams', () => {
    test('redacts single sensitive query param (key)', () => {
      expect(redactUrlQueryCredentials('https://api.example.com?key=AIzaSyABCDEF1234')).toBe(
        'https://api.example.com/?key=***1234'
      );
    });

    test('redacts single sensitive query param (api_key)', () => {
      expect(redactUrlQueryCredentials('https://api.example.com?api_key=sk-abcdef7890')).toBe(
        'https://api.example.com/?api_key=***7890'
      );
    });

    test('redacts single sensitive query param (apiKey camelCase via case-insensitive match)', () => {
      expect(redactUrlQueryCredentials('https://api.example.com?apiKey=secret1234')).toBe(
        'https://api.example.com/?apiKey=***1234'
      );
    });

    test('redacts token query param', () => {
      expect(redactUrlQueryCredentials('https://api.example.com?token=eyJhbGciOiJIUzI1NiJ9')).toBe(
        'https://api.example.com/?token=***NiJ9'
      );
    });

    test('redacts short sensitive values without leaking full value (<= 4 chars)', () => {
      expect(redactUrlQueryCredentials('https://api.example.com?token=abcd')).toBe(
        'https://api.example.com/?token=***'
      );
    });

    test('leaves empty sensitive values empty', () => {
      expect(redactUrlQueryCredentials('https://api.example.com?key=')).toBe(
        'https://api.example.com/?key='
      );
    });

    test('redacts secret query param', () => {
      expect(redactUrlQueryCredentials('https://api.example.com?secret=mysecretvalue')).toBe(
        'https://api.example.com/?secret=***alue'
      );
    });

    test('redacts password query param', () => {
      expect(redactUrlQueryCredentials('https://api.example.com?password=hunter2abc')).toBe(
        'https://api.example.com/?password=***2abc'
      );
    });

    test('redacts multiple sensitive params and preserves non-sensitive params', () => {
      const result = redactUrlQueryCredentials('https://api.example.com?key=abc123&token=xyz789&foo=bar');
      expect(result).toContain('key=***c123');
      expect(result).toContain('token=***z789');
      expect(result).toContain('foo=bar');
    });

    test('preserves non-sensitive params', () => {
      expect(redactUrlQueryCredentials('https://api.example.com?model=example-model&version=v1')).toBe(
        'https://api.example.com/?model=example-model&version=v1'
      );
    });

    test('handles mixed sensitive and non-sensitive params', () => {
      const result = redactUrlQueryCredentials('https://api.example.com?model=example-model&key=secret123&version=v1');
      expect(result).toContain('model=example-model');
      expect(result).toContain('key=***t123');
      expect(result).toContain('version=v1');
    });

    test('handles WebSocket URLs (wss://)', () => {
      expect(redactUrlQueryCredentials('wss://api.example.com/realtime?key=AIzaSy1234')).toBe(
        'wss://api.example.com/realtime?key=***1234'
      );
    });

    test('handles ws:// URLs', () => {
      expect(redactUrlQueryCredentials('ws://api.example.com/realtime?token=abcd1234')).toBe(
        'ws://api.example.com/realtime?token=***1234'
      );
    });

    test('does not modify URLs without query params (preserves formatting)', () => {
      expect(redactUrlQueryCredentials('https://api.example.com/path')).toBe('https://api.example.com/path');
    });

    test('returns original string when URL parsing fails', () => {
      expect(redactUrlQueryCredentials('not-a-url?key=secret')).toBe('not-a-url?key=secret');
    });

    test('supports custom sensitive param list', () => {
      expect(redactUrlQueryCredentials('https://api.example.com?foo=secret1234&bar=ok', ['foo'])).toBe(
        'https://api.example.com/?foo=***1234&bar=ok'
      );
    });

    test('redactUrlQueryParams is an alias of redactUrlQueryCredentials', () => {
      expect(redactUrlQueryParams('https://api.example.com?key=abc123')).toBe(
        redactUrlQueryCredentials('https://api.example.com?key=abc123')
      );
    });
  });

  test('redactUrl redacts both basic-auth credentials and query-string credentials', () => {
    expect(redactUrl('https://user:password@api.example.com?key=abcd1234')).toBe(
      'https://***:***@api.example.com/?key=***1234'
    );
  });

  describe('redactJsonCredentials', () => {
    test('redacts common credential keys recursively', () => {
      const input = {
        api_key: 'sk-abcdef1234',
        nested: {
          token: 'abcd',
          ok: 'value'
        }
      };

      expect(redactJsonCredentials(input)).toEqual({
        api_key: '***1234',
        nested: {
          token: '***',
          ok: 'value'
        }
      });
    });

    test('preserves Bearer prefix when redacting authorization values', () => {
      const input = {
        authorization: 'Bearer sk-abcdef1234'
      };

      expect(redactJsonCredentials(input)).toEqual({
        authorization: 'Bearer ***1234'
      });
    });

    test('redacts short Bearer tokens without leaking full value (<= 4 chars)', () => {
      expect(redactJsonCredentials({ authorization: 'Bearer abcd' })).toEqual({
        authorization: 'Bearer ***'
      });
    });

    test('redacts non-string sensitive values with a placeholder', () => {
      const input = {
        token: { nested: true }
      };

      expect(redactJsonCredentials(input)).toEqual({
        token: '***'
      });
    });

    test('preserves null/undefined sensitive values', () => {
      const input = {
        api_key: null,
        secret: undefined
      };

      expect(redactJsonCredentials(input)).toEqual({
        api_key: null,
        secret: undefined
      });
    });

    test('redacts URL credentials + sensitive query params inside URL-like strings', () => {
      const input = {
        url: 'https://user:pass@api.example.com/path?key=abcd1234&foo=bar'
      };

      expect(redactJsonCredentials(input)).toEqual({
        url: 'https://***:***@api.example.com/path?key=***1234&foo=bar'
      });
    });

    test('handles arrays and WebSocket URLs', () => {
      const input = [
        { token: 'abcd1234' },
        'wss://api.example.com/realtime?token=abcd1234'
      ];

      expect(redactJsonCredentials(input)).toEqual([
        { token: '***1234' },
        'wss://api.example.com/realtime?token=***1234'
      ]);
    });

    test('handles Date, Error, and Buffer values', () => {
      const input = {
        when: new Date('2024-01-01T00:00:00.000Z'),
        err: new Error('boom'),
        buf: Buffer.from('abc')
      };

      expect(redactJsonCredentials(input)).toEqual({
        when: '2024-01-01T00:00:00.000Z',
        err: { name: 'Error', message: 'boom' },
        buf: { redacted: true, type: 'buffer', length: 3 }
      });
    });

    test('handles circular references without throwing', () => {
      const input: any = {};
      input.self = input;
      const result = redactJsonCredentials(input) as any;
      expect(result).toBeDefined();
      expect(result.self).toBe(result);
    });

    test('replaces overly deep values with [MaxDepth]', () => {
      const input: any = {};
      let cursor = input;
      for (let i = 0; i < 30; i++) {
        cursor.next = {};
        cursor = cursor.next;
      }

      const result = redactJsonCredentials(input) as any;
      cursor = result;
      for (let i = 0; i < 25; i++) {
        cursor = cursor.next;
      }

      expect(cursor.next).toBe('[MaxDepth]');
    });

    test('returns original input when traversal throws', () => {
      const input = Object.defineProperty({}, 'boom', {
        enumerable: true,
        get() {
          throw new Error('nope');
        }
      });

      expect(redactJsonCredentials(input)).toBe(input);
    });

    test('preserves non-objects and does not throw', () => {
      expect(redactJsonCredentials('hello')).toBe('hello');
      expect(redactJsonCredentials(123)).toBe(123);
      expect(redactJsonCredentials(null)).toBeNull();
    });
  });
});
