import { describe, it, expect } from '@jest/globals';
import { detectMimeType, isDocumentMimeType, MIME_TYPES } from '@/utils/documents/mime-types.ts';

describe('mime-types', () => {
  describe('detectMimeType', () => {
    it('should detect PDF mime type', () => {
      expect(detectMimeType('document.pdf')).toBe('application/pdf');
      expect(detectMimeType('/path/to/file.pdf')).toBe('application/pdf');
    });

    it('should detect CSV mime type', () => {
      expect(detectMimeType('data.csv')).toBe('text/csv');
    });

    it('should detect TXT mime type', () => {
      expect(detectMimeType('readme.txt')).toBe('text/plain');
    });

    it('should detect JSON mime type', () => {
      expect(detectMimeType('config.json')).toBe('application/json');
    });

    it('should detect HTML mime type', () => {
      expect(detectMimeType('index.html')).toBe('text/html');
      expect(detectMimeType('page.htm')).toBe('text/html');
    });

    it('should detect Microsoft Office DOCX mime type', () => {
      expect(detectMimeType('document.docx')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
    });

    it('should detect Microsoft Office XLSX mime type', () => {
      expect(detectMimeType('spreadsheet.xlsx')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    });

    it('should detect image mime types', () => {
      expect(detectMimeType('image.jpg')).toBe('image/jpeg');
      expect(detectMimeType('image.jpeg')).toBe('image/jpeg');
      expect(detectMimeType('image.png')).toBe('image/png');
      expect(detectMimeType('image.gif')).toBe('image/gif');
      expect(detectMimeType('image.webp')).toBe('image/webp');
    });

    it('should detect markdown mime type', () => {
      expect(detectMimeType('readme.md')).toBe('text/markdown');
      expect(detectMimeType('doc.markdown')).toBe('text/markdown');
    });

    it('should be case insensitive', () => {
      expect(detectMimeType('FILE.PDF')).toBe('application/pdf');
      expect(detectMimeType('DATA.CSV')).toBe('text/csv');
    });

    it('should return application/octet-stream for unknown extensions', () => {
      expect(detectMimeType('file.unknown')).toBe('application/octet-stream');
      expect(detectMimeType('file.xyz')).toBe('application/octet-stream');
    });

    it('should handle files without extensions', () => {
      expect(detectMimeType('file')).toBe('application/octet-stream');
      expect(detectMimeType('/path/to/file')).toBe('application/octet-stream');
    });
  });

  describe('isDocumentMimeType', () => {
    it('should return true for document mime types', () => {
      expect(isDocumentMimeType('application/pdf')).toBe(true);
      expect(isDocumentMimeType('text/csv')).toBe(true);
      expect(isDocumentMimeType('text/plain')).toBe(true);
      expect(isDocumentMimeType('application/json')).toBe(true);
    });

    it('should return false for image mime types', () => {
      expect(isDocumentMimeType('image/jpeg')).toBe(false);
      expect(isDocumentMimeType('image/png')).toBe(false);
      expect(isDocumentMimeType('image/gif')).toBe(false);
      expect(isDocumentMimeType('image/webp')).toBe(false);
    });

    it('should return true for other non-image types', () => {
      expect(isDocumentMimeType('video/mp4')).toBe(true);
      expect(isDocumentMimeType('audio/mpeg')).toBe(true);
      expect(isDocumentMimeType('application/octet-stream')).toBe(true);
    });
  });

  describe('MIME_TYPES constants', () => {
    it('should export common MIME type constants', () => {
      expect(MIME_TYPES.PDF).toBe('application/pdf');
      expect(MIME_TYPES.CSV).toBe('text/csv');
      expect(MIME_TYPES.TXT).toBe('text/plain');
      expect(MIME_TYPES.JSON).toBe('application/json');
      expect(MIME_TYPES.JPEG).toBe('image/jpeg');
      expect(MIME_TYPES.PNG).toBe('image/png');
    });
  });
});
