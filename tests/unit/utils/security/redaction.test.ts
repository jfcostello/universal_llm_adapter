import { describe, expect, test } from '@jest/globals';
import { genericRedactHeaders, redactUrlCredentials } from '@/modules/security/index.ts';

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
});
