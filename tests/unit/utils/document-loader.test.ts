import { describe, it, expect } from '@jest/globals';
import { loadDocumentFromPath, loadDocumentFromBase64, processDocumentContent } from '@/utils/documents/document-loader.ts';
import type { DocumentContent } from '@/core/types.ts';
import * as path from 'path';

const FIXTURES_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'sample-documents');

describe('document-loader', () => {
  describe('loadDocumentFromPath', () => {
    it('should load a PDF file and encode to base64', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.pdf');
      const result = loadDocumentFromPath(filePath);

      expect(result.data).toBeTruthy();
      expect(typeof result.data).toBe('string');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('sample.pdf');
      expect(result.sizeBytes).toBeGreaterThan(0);

      // Verify base64 is valid (should only contain base64 characters)
      expect(result.data).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    });

    it('should load a CSV file', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.csv');
      const result = loadDocumentFromPath(filePath);

      expect(result.data).toBeTruthy();
      expect(result.mimeType).toBe('text/csv');
      expect(result.filename).toBe('sample.csv');
      expect(result.sizeBytes).toBeGreaterThan(0);
    });

    it('should load a TXT file', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const result = loadDocumentFromPath(filePath);

      expect(result.data).toBeTruthy();
      expect(result.mimeType).toBe('text/plain');
      expect(result.filename).toBe('sample.txt');
      expect(result.sizeBytes).toBeGreaterThan(0);
    });

    it('should load a JSON file', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.json');
      const result = loadDocumentFromPath(filePath);

      expect(result.data).toBeTruthy();
      expect(result.mimeType).toBe('application/json');
      expect(result.filename).toBe('sample.json');
      expect(result.sizeBytes).toBeGreaterThan(0);
    });

    it('should auto-detect MIME type from extension', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.csv');
      const result = loadDocumentFromPath(filePath);

      expect(result.mimeType).toBe('text/csv');
    });

    it('should allow MIME type override', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const result = loadDocumentFromPath(filePath, 'text/custom');

      expect(result.mimeType).toBe('text/custom');
    });

    it('should allow filename override', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const result = loadDocumentFromPath(filePath, undefined, 'custom-name.txt');

      expect(result.filename).toBe('custom-name.txt');
    });

    it('should throw error for non-existent file', () => {
      expect(() => {
        loadDocumentFromPath('/nonexistent/file.pdf');
      }).toThrow('File not found');
    });

    it('should handle files in nested directories', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const result = loadDocumentFromPath(filePath);

      expect(result.filename).toBe('sample.txt');
    });
  });

  describe('loadDocumentFromBase64', () => {
    it('should create LoadedDocument from base64 string', () => {
      const base64Data = 'SGVsbG8gV29ybGQ='; // "Hello World"
      const result = loadDocumentFromBase64(base64Data, 'text/plain', 'test.txt');

      expect(result.data).toBe(base64Data);
      expect(result.mimeType).toBe('text/plain');
      expect(result.filename).toBe('test.txt');
      expect(result.sizeBytes).toBeGreaterThan(0);
    });

    it('should estimate file size correctly', () => {
      // "Hello World" in base64 is "SGVsbG8gV29ybGQ="
      // Original is 11 bytes, base64 is 16 characters
      const base64Data = 'SGVsbG8gV29ybGQ=';
      const result = loadDocumentFromBase64(base64Data, 'text/plain');

      // Should estimate ~11 bytes (allowing some margin)
      expect(result.sizeBytes).toBeGreaterThanOrEqual(10);
      expect(result.sizeBytes).toBeLessThanOrEqual(12);
    });

    it('should use default filename when not provided', () => {
      const result = loadDocumentFromBase64('dGVzdA==', 'text/plain');

      expect(result.filename).toBe('document');
    });
  });

  describe('processDocumentContent', () => {
    it('should load file from filepath source and convert to base64', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: filePath }
      };

      const result = processDocumentContent(content);

      expect(result.type).toBe('document');
      expect(result.source.type).toBe('base64');
      if (result.source.type === 'base64') {
        expect(result.source.data).toBeTruthy();
        expect(result.source.data).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      }
      expect(result.mimeType).toBe('text/plain');
      expect(result.filename).toBe('sample.txt');
    });

    it('should preserve existing mimeType when loading from filepath', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: filePath },
        mimeType: 'text/custom'
      };

      const result = processDocumentContent(content);

      expect(result.mimeType).toBe('text/custom');
    });

    it('should preserve existing filename when loading from filepath', () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.txt');
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'filepath', path: filePath },
        filename: 'custom.txt'
      };

      const result = processDocumentContent(content);

      expect(result.filename).toBe('custom.txt');
    });

    it('should pass through base64 source unchanged', () => {
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'base64', data: 'dGVzdA==' },
        mimeType: 'text/plain',
        filename: 'test.txt'
      };

      const result = processDocumentContent(content);

      expect(result.source.type).toBe('base64');
      if (result.source.type === 'base64') {
        expect(result.source.data).toBe('dGVzdA==');
      }
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

      expect(result.source.type).toBe('url');
      if (result.source.type === 'url') {
        expect(result.source.url).toBe('https://example.com/doc.pdf');
      }
    });

    it('should pass through file_id source unchanged', () => {
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'file_id', fileId: 'file-abc123' },
        mimeType: 'application/pdf',
        filename: 'doc.pdf'
      };

      const result = processDocumentContent(content);

      expect(result.source.type).toBe('file_id');
      if (result.source.type === 'file_id') {
        expect(result.source.fileId).toBe('file-abc123');
      }
    });

    it('should throw error if mimeType missing for non-filepath sources', () => {
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

    it('should preserve providerOptions', () => {
      const content: DocumentContent = {
        type: 'document',
        source: { type: 'base64', data: 'dGVzdA==' },
        mimeType: 'text/plain',
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
  });
});
