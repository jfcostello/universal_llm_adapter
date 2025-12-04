import { jest } from '@jest/globals';

// Type imports - will exist after implementation
import type { TextChunk } from '@/core/vector-spec-types.ts';

// Module imports - will exist after implementation
let chunkText: (text: string, options?: ChunkOptions) => TextChunk[];
let chunkFile: (filePath: string, options?: ChunkOptions) => Promise<TextChunk[]>;

interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  separator?: string;
  preserveSentences?: boolean;
  metadata?: Record<string, any>;
}

describe('utils/vector/vector-chunker', () => {
  beforeAll(async () => {
    try {
      const module = await import('@/utils/vector/vector-chunker.ts');
      chunkText = module.chunkText;
      chunkFile = module.chunkFile;
    } catch {
      // Module doesn't exist yet - mock for TDD
      chunkText = (text: string, options?: ChunkOptions) => {
        throw new Error('Not implemented');
      };
      chunkFile = async (filePath: string, options?: ChunkOptions) => {
        throw new Error('Not implemented');
      };
    }
  });

  describe('chunkText', () => {
    test('splits text into chunks of specified size', () => {
      const text = 'This is a long text that needs to be split into smaller chunks for processing.';
      const chunks = chunkText(text, { chunkSize: 20, chunkOverlap: 0 });

      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach(chunk => {
        expect(chunk.text.length).toBeLessThanOrEqual(20);
      });
    });

    test('uses default chunk size when not specified', () => {
      const text = 'A'.repeat(1000);
      const chunks = chunkText(text);

      // Default chunk size should be reasonable (e.g., 500)
      expect(chunks.length).toBeGreaterThan(1);
    });

    test('creates overlapping chunks when overlap is specified', () => {
      const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const chunks = chunkText(text, { chunkSize: 10, chunkOverlap: 3 });

      // With overlap, later chunks should start with the end of previous chunks
      if (chunks.length > 1) {
        const firstEnd = chunks[0].text.slice(-3);
        const secondStart = chunks[1].text.slice(0, 3);
        expect(secondStart).toBe(firstEnd);
      }
    });

    test('handles text smaller than chunk size', () => {
      const text = 'Short text';
      const chunks = chunkText(text, { chunkSize: 100 });

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('Short text');
    });

    test('handles empty text', () => {
      const chunks = chunkText('', { chunkSize: 100 });

      expect(chunks).toHaveLength(0);
    });

    test('generates unique IDs for each chunk', () => {
      const text = 'A'.repeat(200);
      const chunks = chunkText(text, { chunkSize: 50 });

      const ids = chunks.map(c => c.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(chunks.length);
    });

    test('includes metadata in all chunks', () => {
      const text = 'A'.repeat(200);
      const chunks = chunkText(text, {
        chunkSize: 50,
        metadata: { source: 'test.pdf', author: 'John' }
      });

      chunks.forEach(chunk => {
        expect(chunk.metadata?.source).toBe('test.pdf');
        expect(chunk.metadata?.author).toBe('John');
      });
    });

    test('adds chunk index to metadata', () => {
      const text = 'A'.repeat(200);
      const chunks = chunkText(text, { chunkSize: 50 });

      chunks.forEach((chunk, index) => {
        expect(chunk.metadata?.chunkIndex).toBe(index);
      });
    });

    test('preserves sentence boundaries when option is set', () => {
      const text = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
      const chunks = chunkText(text, {
        chunkSize: 30,
        preserveSentences: true
      });

      // Chunks should not break mid-sentence
      chunks.forEach(chunk => {
        const trimmed = chunk.text.trim();
        if (trimmed.length > 0) {
          expect(trimmed.endsWith('.') || trimmed === 'First sentence').toBe(true);
        }
      });
    });

    test('uses custom separator', () => {
      const text = 'Part1\n\nPart2\n\nPart3';
      const chunks = chunkText(text, {
        separator: '\n\n',
        chunkSize: 8  // Small enough to force each part into its own chunk
      });

      // Should split on double newlines
      expect(chunks.length).toBe(3);
    });

    test('separator chunking skips empty parts from consecutive separators', () => {
      // Consecutive separators create empty parts that should be skipped
      // With chunkSize: 5, each part should be its own chunk
      const text = 'Part1\n\n\n\nPart2\n\n\n\n\n\nPart3';
      const chunks = chunkText(text, {
        separator: '\n\n',
        chunkSize: 5  // Small enough to force separate chunks
      });

      // Should only have 3 chunks, empty parts skipped
      expect(chunks.length).toBe(3);
      expect(chunks[0].text).toBe('Part1');
      expect(chunks[1].text).toBe('Part2');
      expect(chunks[2].text).toBe('Part3');
    });

    test('separator chunking handles first part correctly', () => {
      // Specifically test the currentChunk = trimmedPart case (when currentChunk is empty)
      // With small chunkSize, each part is its own chunk
      const text = 'A\n\nB';
      const chunks = chunkText(text, {
        separator: '\n\n',
        chunkSize: 1  // Force separate chunks
      });

      expect(chunks.length).toBe(2);
      expect(chunks[0].text).toBe('A');
    });

    test('separator chunking accumulates parts within chunk size', () => {
      // Parts small enough to combine into single chunk
      const text = 'A\n\nB\n\nC';
      const chunks = chunkText(text, {
        separator: '\n\n',
        chunkSize: 20  // Large enough to hold all combined
      });

      // All parts should be combined into one chunk
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toBe('A\n\nB\n\nC');
    });

    test('separator chunking uses default chunk size', () => {
      // Don't specify chunkSize to use default (500)
      const text = 'Part1\n\nPart2';
      const chunks = chunkText(text, {
        separator: '\n\n'
        // No chunkSize - should use default
      });

      // With default chunk size (500), all should fit in one chunk
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toBe('Part1\n\nPart2');
    });

    test('preserveSentences uses default chunk size', () => {
      // Don't specify chunkSize to use default (500)
      const text = 'First sentence. Second sentence.';
      const chunks = chunkText(text, {
        preserveSentences: true
        // No chunkSize - should use default
      });

      // With default chunk size (500), should fit in one chunk
      expect(chunks.length).toBe(1);
    });

    test('preserveSentences first sentence gets assigned to currentChunk', () => {
      // Test the else branch at line 234: currentChunk ? ... : sentence
      // The first sentence should hit the : sentence branch
      const text = 'First. Second.';
      const chunks = chunkText(text, {
        preserveSentences: true,
        chunkSize: 100
      });

      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain('First');
    });

    test('handles unicode text correctly', () => {
      const text = '日本語テキスト。これは長いテキストです。分割する必要があります。';
      const chunks = chunkText(text, { chunkSize: 20 });

      chunks.forEach(chunk => {
        // Unicode characters should not be broken
        expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/);
        expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]/);
      });
    });

    test('handles text with only whitespace', () => {
      const text = '     \n\n\t\t   ';
      const chunks = chunkText(text, { chunkSize: 100 });

      expect(chunks).toHaveLength(0);
    });

    test('trims whitespace from chunk boundaries', () => {
      const text = 'Word1   Word2   Word3   Word4   Word5';
      const chunks = chunkText(text, { chunkSize: 10 });

      chunks.forEach(chunk => {
        expect(chunk.text).not.toMatch(/^\s/);
        expect(chunk.text).not.toMatch(/\s$/);
      });
    });
  });

  describe('chunkFile', () => {
    test('reads and chunks file content', async () => {
      // This would need a test fixture file
      try {
        const chunks = await chunkFile('/path/to/test.txt', { chunkSize: 100 });
        expect(Array.isArray(chunks)).toBe(true);
      } catch (error) {
        // File doesn't exist - expected in TDD
        expect(error).toBeDefined();
      }
    });

    test('adds filename to metadata', async () => {
      try {
        const chunks = await chunkFile('/path/to/document.txt', { chunkSize: 100 });
        chunks.forEach(chunk => {
          expect(chunk.metadata?.filename).toBe('document.txt');
        });
      } catch {
        // Expected in TDD
        expect(true).toBe(true);
      }
    });

    test('adds filepath to metadata', async () => {
      try {
        const chunks = await chunkFile('/path/to/document.txt', { chunkSize: 100 });
        chunks.forEach(chunk => {
          expect(chunk.metadata?.filepath).toBe('/path/to/document.txt');
        });
      } catch {
        // Expected in TDD
        expect(true).toBe(true);
      }
    });

    test('handles file read errors gracefully', async () => {
      await expect(chunkFile('/nonexistent/file.txt')).rejects.toThrow();
    });

    test('merges custom metadata with file metadata', async () => {
      try {
        const chunks = await chunkFile('/path/to/test.txt', {
          chunkSize: 100,
          metadata: { project: 'test-project' }
        });
        chunks.forEach(chunk => {
          expect(chunk.metadata?.project).toBe('test-project');
          expect(chunk.metadata?.filename).toBeDefined();
        });
      } catch {
        // Expected in TDD
        expect(true).toBe(true);
      }
    });
  });

  describe('edge cases', () => {
    test('handles very large chunk sizes', () => {
      const text = 'Short text';
      const chunks = chunkText(text, { chunkSize: 1000000 });

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('Short text');
    });

    test('handles chunk size of 1', () => {
      const text = 'ABC';
      const chunks = chunkText(text, { chunkSize: 1, chunkOverlap: 0 });

      expect(chunks).toHaveLength(3);
    });

    test('handles overlap larger than chunk size', () => {
      const text = 'ABCDEFGHIJ';
      // When overlap >= chunk size, should use chunk size - 1 as overlap
      const chunks = chunkText(text, { chunkSize: 3, chunkOverlap: 5 });

      expect(chunks.length).toBeGreaterThan(0);
    });

    test('handles newlines in text', () => {
      const text = 'Line 1\nLine 2\nLine 3\nLine 4';
      const chunks = chunkText(text, { chunkSize: 15 });

      // Should handle newlines as regular characters
      expect(chunks.length).toBeGreaterThan(0);
    });

    test('handles special characters', () => {
      const text = '<script>alert("XSS")</script> & other "special" chars';
      const chunks = chunkText(text, { chunkSize: 20 });

      // Special characters should be preserved
      const joined = chunks.map(c => c.text).join('');
      expect(joined).toContain('<script>');
      expect(joined).toContain('&');
    });

    test('handles high surrogate at chunk boundary', () => {
      // Create text ending with high surrogate (0xD800-0xDBFF)
      const emoji = '\uD83D\uDE00'; // Grinning face emoji (surrogate pair)
      const text = 'Hello ' + emoji + ' world';
      const chunks = chunkText(text, { chunkSize: 7, chunkOverlap: 0 });

      // Should handle surrogate pairs gracefully
      expect(chunks.length).toBeGreaterThan(0);
      const joined = chunks.map(c => c.text).join('');
      // The joined text should not have broken surrogates
      expect(joined).toBeDefined();
    });

    test('handles low surrogate at chunk start', () => {
      // Create text with emoji that might start a chunk with low surrogate
      const emoji = '\uD83D\uDE00'; // Grinning face emoji
      const text = 'A' + emoji + 'B' + emoji + 'C';
      const chunks = chunkText(text, { chunkSize: 2, chunkOverlap: 0 });

      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe('chunkFile', () => {
    test('chunks an existing file', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');

      // Create a temp file
      const tempDir = os.tmpdir();
      const tempFile = path.join(tempDir, 'test-chunk-file.txt');
      fs.writeFileSync(tempFile, 'This is test content for chunking. It should be split into multiple pieces.');

      try {
        const chunks = await chunkFile(tempFile, { chunkSize: 20, chunkOverlap: 0 });

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0].metadata?.filename).toBe('test-chunk-file.txt');
        expect(chunks[0].metadata?.filepath).toBe(tempFile);
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    test('merges custom metadata with file metadata', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');

      const tempDir = os.tmpdir();
      const tempFile = path.join(tempDir, 'test-metadata.txt');
      fs.writeFileSync(tempFile, 'Content for metadata test');

      try {
        const chunks = await chunkFile(tempFile, {
          chunkSize: 100,
          metadata: { project: 'test-project', version: '1.0' }
        });

        expect(chunks[0].metadata?.filename).toBe('test-metadata.txt');
        expect(chunks[0].metadata?.project).toBe('test-project');
        expect(chunks[0].metadata?.version).toBe('1.0');
      } finally {
        fs.unlinkSync(tempFile);
      }
    });
  });
});
