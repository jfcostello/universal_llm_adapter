import fs from 'fs';
import os from 'os';
import path from 'path';

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

  test('rejects filepath document sources when the referenced file does not exist', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-policy-missing-file-'));
    const policy = normalizeServerPolicy({ documents: { filepath: { enabled: true } } });

    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath', path: 'missing.txt' } }]
            }
          ]
        } as any,
        policy,
        { cwd }
      )
    ).toThrow(/does not exist/i);
  });

  test('rejects when allowedRoots contains an invalid entry', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-policy-bad-root-'));
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'ok');
    const policy = normalizeServerPolicy({
      documents: { filepath: { enabled: true, allowedRoots: ['this/does/not/exist'] } }
    });

    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath', path: 'file.txt' } }]
            }
          ]
        } as any,
        policy,
        { cwd }
      )
    ).toThrow(/allowedRoots entry/i);
  });

  test('defaults allowedRoots to cwd when enabled and allowedRoots is empty', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-policy-cwd-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-policy-outside-'));

    const inRootFile = path.join(cwd, 'allowed.txt');
    const outsideFile = path.join(outside, 'blocked.txt');
    fs.writeFileSync(inRootFile, 'ok');
    fs.writeFileSync(outsideFile, 'nope');

    const policy = normalizeServerPolicy({ documents: { filepath: { enabled: true, allowedRoots: [] } } });

    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath', path: inRootFile } }]
            }
          ]
        } as any,
        policy,
        { cwd }
      )
    ).not.toThrow();

    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath', path: outsideFile } }]
            }
          ]
        } as any,
        policy,
        { cwd }
      )
    ).toThrow(/allowedRoots/i);
  });

  test('enforces allowedRoots for filepath document sources', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-policy-roots-'));
    const allowedDir = path.join(cwd, 'allowed');
    const nopeDir = path.join(cwd, 'nope');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(nopeDir, { recursive: true });
    fs.writeFileSync(path.join(allowedDir, 'file.txt'), 'ok');
    fs.writeFileSync(path.join(nopeDir, 'file.txt'), 'nope');

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
        { cwd }
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
        { cwd }
      )
    ).toThrow(/outside of allowedRoots/i);
  });

  test('rejects symlink escape out of an allowed root', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-policy-symlink-'));
    const allowedDir = path.join(cwd, 'allowed');
    const outsideDir = path.join(cwd, 'outside');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');

    const linkDir = path.join(allowedDir, 'link');
    fs.symlinkSync(outsideDir, linkDir, 'junction');

    const policy = normalizeServerPolicy({ documents: { filepath: { enabled: true, allowedRoots: ['allowed'] } } });
    expect(() =>
      assertLlmSpecAllowedByPolicy(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'filepath', path: 'allowed/link/secret.txt' } }]
            }
          ]
        } as any,
        policy,
        { cwd }
      )
    ).toThrow(/allowedRoots/i);
  });
});
