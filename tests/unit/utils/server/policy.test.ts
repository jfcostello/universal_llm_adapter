import { assertLlmSpecAllowedByPolicy, normalizeServerPolicy } from '@/modules/server/internal/security/policy.ts';

describe('utils/server policy', () => {
  test('normalizeServerPolicy defaults to disabled', () => {
    const policy = normalizeServerPolicy(undefined);
    expect(policy.documents.filepath.enabled).toBe(false);
    expect(policy.documents.filepath.allowedRoots).toEqual([]);
  });

  test('normalizeServerPolicy trims and filters allowedRoots', () => {
    const policy = normalizeServerPolicy({
      documents: { filepath: { enabled: true, allowedRoots: [' a ', '', '  ', 'b'] } }
    });
    expect(policy.documents.filepath.enabled).toBe(true);
    expect(policy.documents.filepath.allowedRoots).toEqual(['a', 'b']);
  });

  test('allows specs without filepath documents', () => {
    const policy = normalizeServerPolicy(undefined);
    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'hello' },
                { type: 'document', source: { type: 'base64', data: 'AAA=' } }
              ]
            }
          ]
        } as any,
        policy
      )
    ).not.toThrow();
  });

  test('treats non-array message content as empty', () => {
    const policy = normalizeServerPolicy(undefined);
    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: null
            }
          ]
        } as any,
        policy
      )
    ).not.toThrow();
  });

  test('treats missing messages as empty', () => {
    const policy = normalizeServerPolicy(undefined);
    expect(() => assertLlmSpecAllowedByPolicy({} as any, policy)).not.toThrow();
  });

  test('rejects filepath document sources when disabled', () => {
    const policy = normalizeServerPolicy({ documents: { filepath: { enabled: false } } });
    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath', path: 'allowed/file.txt' } }]
            }
          ]
        } as any,
        policy
      )
    ).toThrow(/disabled by server policy/i);
  });

  test('rejects filepath document sources with missing path', () => {
    const policy = normalizeServerPolicy({ documents: { filepath: { enabled: true } } });
    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath', path: '' } }]
            }
          ]
        } as any,
        policy
      )
    ).toThrow(/missing path/i);

    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath' } }]
            }
          ]
        } as any,
        policy
      )
    ).toThrow(/missing path/i);
  });

  test('allows filepath document sources when enabled and allowedRoots is empty', () => {
    const policy = normalizeServerPolicy({ documents: { filepath: { enabled: true, allowedRoots: [] } } });
    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath', path: '/etc/passwd' } }]
            }
          ]
        } as any,
        policy
      )
    ).not.toThrow();
  });

  test('enforces allowedRoots for filepath document sources', () => {
    const policy = normalizeServerPolicy({ documents: { filepath: { enabled: true, allowedRoots: ['allowed'] } } });
    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath', path: 'allowed/file.txt' } }]
            }
          ]
        } as any,
        policy,
        { cwd: '/tmp' }
      )
    ).not.toThrow();

    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath', path: 'nope/file.txt' } }]
            }
          ]
        } as any,
        policy,
        { cwd: '/tmp' }
      )
    ).toThrow(/outside of allowedRoots/i);
  });
});
