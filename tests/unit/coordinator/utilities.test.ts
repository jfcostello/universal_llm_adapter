import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { sanitizeToolChoice } from '@/utils/tools/tool-names.ts';

function instance(): any {
  return new LLMCoordinator({
    getMCPServers: () => [],
    getProcessRoutes: () => [],
    getProvider: () => ({}),
    getVectorStores: () => []
  } as any);
}

describe('coordinator utility helpers', () => {
  test('sanitizeToolName handles invalid and long names', () => {
    const coordinator = instance();
    const sanitize = (coordinator as any).sanitizeToolName.bind(coordinator);

    expect(sanitize('tool/name?')).toBe('tool_name_');
    expect(sanitize('')).toBe('tool');
    const long = 'x'.repeat(100);
    expect(sanitize(long)).toHaveLength(64);
  });

  test('normalizeFlag covers booleans, numbers, strings, and fallback', () => {
    const coordinator = instance();
    const normalize = (coordinator as any).normalizeFlag.bind(coordinator);

    expect(normalize(undefined, true)).toBe(true);
    expect(normalize(false, true)).toBe(false);
    expect(normalize(1, false)).toBe(true);
    expect(normalize('yes', false)).toBe(true);
    expect(normalize('off', true)).toBe(false);
    expect(normalize('maybe', true)).toBe(true);
    expect(normalize({}, false)).toBe(true);
  });
});

describe('sanitizeToolChoice', () => {
  test('returns undefined for undefined input', () => {
    expect(sanitizeToolChoice(undefined)).toBeUndefined();
  });

  test('returns string choices unchanged', () => {
    expect(sanitizeToolChoice('auto')).toBe('auto');
    expect(sanitizeToolChoice('none')).toBe('none');
  });

  test('sanitizes single tool choice name', () => {
    const choice = { type: 'single' as const, name: 'test.echo' };
    const result = sanitizeToolChoice(choice);
    expect(result).toEqual({ type: 'single', name: 'test_echo' });
  });

  test('sanitizes required tool choice allowed list', () => {
    const choice = { type: 'required' as const, allowed: ['test.echo', 'my.tool'] };
    const result = sanitizeToolChoice(choice);
    expect(result).toEqual({ type: 'required', allowed: ['test_echo', 'my_tool'] });
  });

  test('handles names with special characters', () => {
    const choice = { type: 'single' as const, name: 'tool/name?' };
    const result = sanitizeToolChoice(choice);
    expect(result).toEqual({ type: 'single', name: 'tool_name_' });
  });

  test('handles required choice with multiple tools', () => {
    const choice = { type: 'required' as const, allowed: ['a.b', 'c/d', 'e_f'] };
    const result = sanitizeToolChoice(choice);
    expect(result).toEqual({ type: 'required', allowed: ['a_b', 'c_d', 'e_f'] });
  });

  test('returns unknown choice types unchanged (defensive fallback)', () => {
    // This tests the defensive fallback for any future/unknown choice types
    const unknownChoice = { type: 'unknown' as any, data: 'test' };
    const result = sanitizeToolChoice(unknownChoice);
    expect(result).toEqual({ type: 'unknown', data: 'test' });
  });
});
