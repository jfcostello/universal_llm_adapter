import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { DocumentContent, Message, Role } from '@/core/types.ts';
import { processDocumentContent } from '@/utils/documents/document-loader.ts';
import * as path from 'path';
import * as fs from 'fs';

const FIXTURES_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'sample-documents');

describe('Document Preprocessing Integration', () => {
  describe('filepath to base64 conversion', () => {
    it('should convert filepath source to base64 source', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: filePath }
      };

      const result = processDocumentContent(content);

      expect(result.source.type).toBe('base64');
      if (result.source.type === 'base64') {
        expect(result.source.data).toBeTruthy();
        expect(result.source.data.length).toBeGreaterThan(0);
        // Verify it's valid base64
        expect(result.source.data).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      }
      expect(result.mimeType).toBe('text/plain');
      expect(result.filename).toBe('sample.txt');
    });

    it('should auto-detect MIME type from file extension', () => {
      const testCases = [
        { file: 'sample.pdf', expected: 'application/pdf' },
        { file: 'sample.csv', expected: 'text/csv' },
        { file: 'sample.txt', expected: 'text/plain' },
        { file: 'sample.json', expected: 'application/json' }
      ];

      for (const testCase of testCases) {
        const filePath = path.join(FIXTURES_DIR, testCase.file);
        const content: DocumentContent = {
          type: 'document',
          source: { type: 'filepath', path: filePath }
        };

        const result = processDocumentContent(content);

        expect(result.mimeType).toBe(testCase.expected);
      }
    });

    it('should extract filename from file path', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: filePath }
      };

      const result = processDocumentContent(content);

      expect(result.filename).toBe('sample.txt');
    });

    it('should preserve user-provided mimeType over auto-detection', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: filePath },
        mimeType: 'text/custom'
      };

      const result = processDocumentContent(content);

      expect(result.mimeType).toBe('text/custom');
    });

    it('should preserve user-provided filename', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: filePath },
        filename: 'custom-name.txt'
      };

      const result = processDocumentContent(content);

      expect(result.filename).toBe('custom-name.txt');
    });

    it('should throw error for non-existent file', () => {
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: '/nonexistent/file.pdf' }
      };

      expect(() => {
        processDocumentContent(content);
      }).toThrow('File not found');
    });
  });

  describe('non-filepath sources', () => {
    it('should pass through base64 source unchanged', () => {
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'base64', data: 'SGVsbG8gV29ybGQ=' },
        mimeType: 'text/plain',
        filename: 'test.txt'
      };

      const result = processDocumentContent(content);

      expect(result.source).toEqual({ type: 'base64', data: 'SGVsbG8gV29ybGQ=' });
      expect(result.mimeType).toBe('text/plain');
      expect(result.filename).toBe('test.txt');
    });

    it('should pass through url source unchanged', () => {
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'url', url: 'https://example.com/doc.pdf' },
        mimeType: 'application/pdf',
        filename: 'doc.pdf'
      };

      const result = processDocumentContent(content);

      expect(result.source).toEqual({ type: 'url', url: 'https://example.com/doc.pdf' });
      expect(result.mimeType).toBe('application/pdf');
    });

    it('should pass through file_id source unchanged', () => {
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'file_id', fileId: 'file-abc123' },
        mimeType: 'application/pdf',
        filename: 'doc.pdf'
      };

      const result = processDocumentContent(content);

      expect(result.source).toEqual({ type: 'file_id', fileId: 'file-abc123' });
    });

    it('should require mimeType for non-filepath sources', () => {
      const content = {
        type: 'document' as const,
        source: { type: 'base64' as const, data: 'dGVzdA==' }
      };

      expect(() => {
        processDocumentContent(content as DocumentContent);
      }).toThrow('mimeType is required for non-filepath document sources');
    });

    it('should set default filename for non-filepath sources without filename', () => {
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'base64', data: 'dGVzdA==' },
        mimeType: 'text/plain'
      };

      const result = processDocumentContent(content);

      expect(result.filename).toBe('document');
    });
  });

  describe('provider-specific options preservation', () => {
    it('should preserve Anthropic cache control options', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.pdf');
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: filePath },
        providerOptions: {
          anthropic: {
            cacheControl: { type: 'ephemeral' }
          }
        }
      };

      const result = processDocumentContent(content);

      expect(result.providerOptions).toEqual({
        anthropic: {
          cacheControl: { type: 'ephemeral' }
        }
      });
    });

    it('should preserve OpenRouter plugin options', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.pdf');
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: filePath },
        providerOptions: {
          openrouter: {
            plugin: 'pdf-text'
          }
        }
      };

      const result = processDocumentContent(content);

      expect(result.providerOptions).toEqual({
        openrouter: {
          plugin: 'pdf-text'
        }
      });
    });
  });

  describe('multiple documents in message', () => {
    it('should process multiple filepath documents', () => {
      const documents: DocumentContent[] = [
        {
          type: 'document',
          source: { type: 'filepath', path: path.join(FIXTURES_DIR, 'sample.txt') }
        },
        {
          type: 'document',
          source: { type: 'filepath', path: path.join(FIXTURES_DIR, 'sample.csv') }
        }
      ];

      const results = documents.map(doc => processDocumentContent(doc));

      expect(results).toHaveLength(2);
      expect(results[0].source.type).toBe('base64');
      expect(results[0].mimeType).toBe('text/plain');
      expect(results[1].source.type).toBe('base64');
      expect(results[1].mimeType).toBe('text/csv');
    });

    it('should handle mix of filepath and non-filepath sources', () => {
      const documents: DocumentContent[] = [
        {
          type: 'document',
          source: { type: 'filepath', path: path.join(FIXTURES_DIR, 'sample.txt') }
        },
        {
          type: 'document',
          source: { type: 'base64', data: 'dGVzdA==' },
          mimeType: 'text/plain',
          filename: 'inline.txt'
        },
        {
          type: 'document',
          source: { type: 'url', url: 'https://example.com/doc.pdf' },
          mimeType: 'application/pdf'
        }
      ];

      const results = documents.map(doc => processDocumentContent(doc));

      expect(results).toHaveLength(3);
      expect(results[0].source.type).toBe('base64'); // Converted from filepath
      expect(results[1].source.type).toBe('base64'); // Already base64
      expect(results[2].source.type).toBe('url'); // Unchanged
    });
  });

  describe('edge cases', () => {
    it('should handle empty files', () => {
      // Create an empty test file
      const tempFile = path.join(FIXTURES_DIR, 'temp-empty.txt');
      fs.writeFileSync(tempFile, '');

      try {
        const content: DocumentContent = {
          type: 'document',
          source: { type: 'filepath', path: tempFile }
        };

        const result = processDocumentContent(content);

        expect(result.source.type).toBe('base64');
        if (result.source.type === 'base64') {
          // Empty file should still produce valid (but empty) base64
          expect(result.source.data).toBe('');
        }
      } finally {
        // Clean up
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      }
    });

    it('should handle large file paths', () => {
      const longFilename = 'a'.repeat(200) + '.txt';
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: `/nonexistent/${longFilename}` }
      };

      expect(() => {
        processDocumentContent(content);
      }).toThrow('File not found');
    });

    it('should handle files with no extension', () => {
      const tempFile = path.join(FIXTURES_DIR, 'README');
      const originalContent = fs.readFileSync(path.join(FIXTURES_DIR, 'README.md'));
      fs.writeFileSync(tempFile, originalContent);

      try {
        const content: DocumentContent = {
          type: 'document',
          source: { type: 'filepath', path: tempFile }
        };

        const result = processDocumentContent(content);

        // Should use fallback MIME type
        expect(result.mimeType).toBe('application/octet-stream');
        expect(result.filename).toBe('README');
      } finally {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      }
    });
  });
});
