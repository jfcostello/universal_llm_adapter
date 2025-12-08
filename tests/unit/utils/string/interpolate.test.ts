import { describe, test, expect } from '@jest/globals';
import { interpolate } from '@/utils/string/interpolate.ts';

describe('utils/string/interpolate', () => {
  describe('basic interpolation', () => {
    test('replaces single placeholder', () => {
      const result = interpolate('Hello {{name}}!', { name: 'World' });
      expect(result).toBe('Hello World!');
    });

    test('replaces multiple placeholders', () => {
      const result = interpolate('{{greeting}} {{name}}!', { greeting: 'Hello', name: 'World' });
      expect(result).toBe('Hello World!');
    });

    test('handles template with no placeholders', () => {
      const result = interpolate('No placeholders here', { name: 'ignored' });
      expect(result).toBe('No placeholders here');
    });

    test('handles empty template', () => {
      const result = interpolate('', { name: 'ignored' });
      expect(result).toBe('');
    });
  });

  describe('nested key access', () => {
    test('accesses nested object properties', () => {
      const result = interpolate('{{payload.text}}', {
        payload: { text: 'Nested value' }
      });
      expect(result).toBe('Nested value');
    });

    test('accesses deeply nested properties', () => {
      const result = interpolate('{{a.b.c.d}}', {
        a: { b: { c: { d: 'Deep value' } } }
      });
      expect(result).toBe('Deep value');
    });

    test('handles mixed nested and top-level keys', () => {
      const result = interpolate('{{payload.text}} (score: {{score}})', {
        score: 0.95,
        payload: { text: 'Result' }
      });
      expect(result).toBe('Result (score: 0.95)');
    });
  });

  describe('missing/null/undefined values', () => {
    test('returns empty string for missing top-level key', () => {
      const result = interpolate('{{missing}}', {});
      expect(result).toBe('');
    });

    test('returns empty string for missing nested key', () => {
      const result = interpolate('{{payload.missing}}', { payload: {} });
      expect(result).toBe('');
    });

    test('returns empty string when parent is null', () => {
      const result = interpolate('{{payload.text}}', { payload: null });
      expect(result).toBe('');
    });

    test('returns empty string when parent is undefined', () => {
      const result = interpolate('{{payload.text}}', { payload: undefined });
      expect(result).toBe('');
    });

    test('returns empty string for deeply nested missing path', () => {
      const result = interpolate('{{a.b.c.d}}', { a: { b: null } });
      expect(result).toBe('');
    });

    test('handles null value at leaf', () => {
      const result = interpolate('{{value}}', { value: null });
      expect(result).toBe('');
    });

    test('handles undefined value at leaf', () => {
      const result = interpolate('{{value}}', { value: undefined });
      expect(result).toBe('');
    });
  });

  describe('type coercion', () => {
    test('converts number to string', () => {
      const result = interpolate('Score: {{score}}', { score: 0.95 });
      expect(result).toBe('Score: 0.95');
    });

    test('converts integer to string', () => {
      const result = interpolate('Count: {{count}}', { count: 42 });
      expect(result).toBe('Count: 42');
    });

    test('converts boolean true to string', () => {
      const result = interpolate('Active: {{active}}', { active: true });
      expect(result).toBe('Active: true');
    });

    test('converts boolean false to string', () => {
      const result = interpolate('Active: {{active}}', { active: false });
      expect(result).toBe('Active: false');
    });

    test('converts zero to string', () => {
      const result = interpolate('Value: {{value}}', { value: 0 });
      expect(result).toBe('Value: 0');
    });

    test('converts empty string as-is', () => {
      const result = interpolate('Value: {{value}}', { value: '' });
      expect(result).toBe('Value: ');
    });
  });

  describe('whitespace handling', () => {
    test('trims whitespace in placeholder keys', () => {
      const result = interpolate('{{ name }}', { name: 'World' });
      expect(result).toBe('World');
    });

    test('trims whitespace in nested keys', () => {
      const result = interpolate('{{ payload.text }}', { payload: { text: 'Value' } });
      expect(result).toBe('Value');
    });

    test('preserves whitespace in values', () => {
      const result = interpolate('{{text}}', { text: '  spaced  ' });
      expect(result).toBe('  spaced  ');
    });
  });

  describe('vector search result formatting (real-world)', () => {
    test('formats result with payload.text and score', () => {
      const result = interpolate('- {{payload.text}} (score: {{score}})', {
        id: 'doc1',
        score: 0.95,
        payload: { text: 'First result' }
      });
      expect(result).toBe('- First result (score: 0.95)');
    });

    test('formats result with custom full_specs field', () => {
      const result = interpolate('{{payload.full_specs}}', {
        id: 'vehicle-123',
        score: 1.0,
        payload: {
          text: '2024 Hyundai Elantra',
          full_specs: '[VEHICLE] 2024 Hyundai Elantra\n[INTERIOR]\nColor: Black'
        }
      });
      expect(result).toBe('[VEHICLE] 2024 Hyundai Elantra\n[INTERIOR]\nColor: Black');
    });

    test('formats result with id, score, and nested metadata', () => {
      const result = interpolate('[{{id}}] {{payload.metadata.category}}: {{payload.text}}', {
        id: 'doc-abc',
        score: 0.87,
        payload: {
          text: 'Document content',
          metadata: { category: 'technology', author: 'Jane' }
        }
      });
      expect(result).toBe('[doc-abc] technology: Document content');
    });

    test('handles missing payload gracefully in vector result', () => {
      const result = interpolate('{{payload.text}}', {
        id: 'doc1',
        score: 0.9,
        payload: null
      });
      expect(result).toBe('');
    });
  });
});
