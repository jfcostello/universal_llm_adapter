import { LLMCoordinator } from '@/coordinator/coordinator.ts';

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
