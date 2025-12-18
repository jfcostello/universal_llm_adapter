import { describe, expect, test } from '@jest/globals';
import { genericRedactHeaders, redactUrlCredentials, redactUrlQueryParams, redactUrl } from '@/modules/security/index.ts';

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

  describe('redactUrlQueryParams', () => {
    test('redacts single sensitive query param (key)', () => {
      expect(redactUrlQueryParams('https://api.example.com?key=AIzaSyABCDEF1234')).toBe(
        'https://api.example.com/?key=***1234'
      );
    });

    test('redacts single sensitive query param (api_key)', () => {
      expect(redactUrlQueryParams('https://api.example.com?api_key=sk-abcdef7890')).toBe(
        'https://api.example.com/?api_key=***7890'
      );
    });

    test('redacts single sensitive query param (apiKey camelCase)', () => {
      expect(redactUrlQueryParams('https://api.example.com?apiKey=secret1234')).toBe(
        'https://api.example.com/?apiKey=***1234'
      );
    });

    test('redacts token query param', () => {
      expect(redactUrlQueryParams('https://api.example.com?token=eyJhbGciOiJIUzI1NiJ9')).toBe(
        'https://api.example.com/?token=***NiJ9'
      );
    });

    test('redacts secret query param', () => {
      expect(redactUrlQueryParams('https://api.example.com?secret=mysecretvalue')).toBe(
        'https://api.example.com/?secret=***alue'
      );
    });

    test('redacts password query param', () => {
      expect(redactUrlQueryParams('https://api.example.com?password=hunter2abc')).toBe(
        'https://api.example.com/?password=***2abc'
      );
    });

    test('redacts multiple sensitive params', () => {
      const result = redactUrlQueryParams('https://api.example.com?key=abc123&token=xyz789&foo=bar');
      expect(result).toContain('key=***c123');
      expect(result).toContain('token=***z789');
      expect(result).toContain('foo=bar');
    });

    test('preserves non-sensitive params', () => {
      expect(redactUrlQueryParams('https://api.example.com?model=gpt-4&version=v1')).toBe(
        'https://api.example.com/?model=gpt-4&version=v1'
      );
    });

    test('handles mixed sensitive and non-sensitive params', () => {
      const result = redactUrlQueryParams('https://api.example.com?model=gpt-4&key=secret123&version=v1');
      expect(result).toContain('model=gpt-4');
      expect(result).toContain('key=***t123');
      expect(result).toContain('version=v1');
    });

    test('handles WebSocket URLs (wss://)', () => {
      expect(redactUrlQueryParams('wss://api.example.com/realtime?key=AIzaSy1234')).toBe(
        'wss://api.example.com/realtime?key=***1234'
      );
    });

    test('handles ws:// URLs', () => {
      expect(redactUrlQueryParams('ws://localhost:8080?token=localtoken')).toBe(
        'ws://localhost:8080/?token=***oken'
      );
    });

    test('handles URL without query params (pass-through)', () => {
      expect(redactUrlQueryParams('https://api.example.com/path')).toBe('https://api.example.com/path');
    });

    test('handles empty query string', () => {
      // With no query params, returns the original URL unchanged
      expect(redactUrlQueryParams('https://api.example.com?')).toBe('https://api.example.com?');
    });

    test('handles short values (less than 4 chars) by fully redacting', () => {
      expect(redactUrlQueryParams('https://api.example.com?key=abc')).toBe(
        'https://api.example.com/?key=***'
      );
    });

    test('handles empty values', () => {
      expect(redactUrlQueryParams('https://api.example.com?key=')).toBe(
        'https://api.example.com/?key='
      );
    });

    test('handles case-insensitive matching for param names', () => {
      expect(redactUrlQueryParams('https://api.example.com?KEY=secret1234')).toBe(
        'https://api.example.com/?KEY=***1234'
      );
      expect(redactUrlQueryParams('https://api.example.com?API_KEY=secret1234')).toBe(
        'https://api.example.com/?API_KEY=***1234'
      );
    });

    test('handles custom sensitive params list', () => {
      expect(redactUrlQueryParams('https://api.example.com?custom=value123&key=noredact', ['custom'])).toBe(
        'https://api.example.com/?custom=***e123&key=noredact'
      );
    });

    test('handles malformed URLs gracefully (returns original)', () => {
      const malformed = 'not-a-valid-url';
      expect(redactUrlQueryParams(malformed)).toBe(malformed);
    });

    test('handles URL with auth and query params', () => {
      // Note: redactUrlQueryParams only handles query params, not basic-auth
      expect(redactUrlQueryParams('https://user:pass@api.example.com?key=secret12')).toBe(
        'https://user:pass@api.example.com/?key=***et12'
      );
    });

    test('preserves URL fragments', () => {
      expect(redactUrlQueryParams('https://api.example.com?key=secret12#section')).toBe(
        'https://api.example.com/?key=***et12#section'
      );
    });

    test('handles credential param', () => {
      expect(redactUrlQueryParams('https://api.example.com?credential=mycred123')).toBe(
        'https://api.example.com/?credential=***d123'
      );
    });

    test('handles auth param', () => {
      expect(redactUrlQueryParams('https://api.example.com?auth=authvalue1')).toBe(
        'https://api.example.com/?auth=***lue1'
      );
    });
  });

  describe('redactUrl', () => {
    test('redacts both basic-auth and query params', () => {
      const result = redactUrl('https://user:password@api.example.com?key=secret1234');
      expect(result).toContain('***:***@');
      expect(result).toContain('key=***1234');
    });

    test('redacts only query params when no basic-auth', () => {
      expect(redactUrl('https://api.example.com?key=secret1234')).toBe(
        'https://api.example.com/?key=***1234'
      );
    });

    test('redacts only basic-auth when no sensitive query params', () => {
      expect(redactUrl('https://user:password@api.example.com?model=gpt-4')).toBe(
        'https://***:***@api.example.com/?model=gpt-4'
      );
    });

    test('passes through clean URLs unchanged', () => {
      expect(redactUrl('https://api.example.com/path')).toBe('https://api.example.com/path');
    });

    test('handles Gemini-style WebSocket URL', () => {
      const geminiUrl = 'wss://generativelanguage.googleapis.com/ws/google.ai?key=AIzaSyABCD1234';
      const result = redactUrl(geminiUrl);
      expect(result).toContain('key=***1234');
      expect(result).not.toContain('AIzaSyABCD1234');
    });
  });
});
