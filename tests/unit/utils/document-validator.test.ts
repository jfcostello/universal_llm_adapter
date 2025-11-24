import { describe, it, expect } from '@jest/globals';
import { isValidBase64, estimateFileSizeFromBase64, formatFileSize } from '@/utils/documents/document-validator.ts';

describe('document-validator', () => {
  describe('isValidBase64', () => {
    it('should return true for valid base64 strings', () => {
      expect(isValidBase64('SGVsbG8gV29ybGQ=')).toBe(true);
      expect(isValidBase64('dGVzdA==')).toBe(true);
      expect(isValidBase64('YWJj')).toBe(true);
      expect(isValidBase64('MTIz')).toBe(true);
    });

    it('should return true for base64 without padding', () => {
      expect(isValidBase64('YWJj')).toBe(true);
      expect(isValidBase64('MTIz')).toBe(true);
    });

    it('should return true for base64 with special characters', () => {
      expect(isValidBase64('abc+def/123=')).toBe(true);
      expect(isValidBase64('xyz+123/abc==')).toBe(true);
    });

    it('should return false for invalid base64 strings', () => {
      expect(isValidBase64('invalid@base64')).toBe(false);
      expect(isValidBase64('has spaces')).toBe(false);
      expect(isValidBase64('special#chars!')).toBe(false);
    });

    it('should return false for strings with invalid padding', () => {
      expect(isValidBase64('abc===')).toBe(false);
      expect(isValidBase64('ab=c')).toBe(false);
    });

    it('should return true for empty string', () => {
      expect(isValidBase64('')).toBe(true);
    });
  });

  describe('estimateFileSizeFromBase64', () => {
    it('should estimate size correctly for simple base64', () => {
      // "Hello World" = 11 bytes
      // Base64: "SGVsbG8gV29ybGQ="
      const base64 = 'SGVsbG8gV29ybGQ=';
      const estimatedSize = estimateFileSizeFromBase64(base64);

      expect(estimatedSize).toBe(11);
    });

    it('should estimate size correctly for base64 without padding', () => {
      // "abc" = 3 bytes
      // Base64: "YWJj"
      const base64 = 'YWJj';
      const estimatedSize = estimateFileSizeFromBase64(base64);

      expect(estimatedSize).toBe(3);
    });

    it('should handle base64 with one padding character', () => {
      // "test" = 4 bytes
      // Base64: "dGVzdA=="
      const base64 = 'dGVzdA==';
      const estimatedSize = estimateFileSizeFromBase64(base64);

      expect(estimatedSize).toBe(4);
    });

    it('should handle base64 with two padding characters', () => {
      // "ab" = 2 bytes
      // Base64: "YWI="
      const base64 = 'YWI=';
      const estimatedSize = estimateFileSizeFromBase64(base64);

      expect(estimatedSize).toBe(2);
    });

    it('should return 0 for empty string', () => {
      expect(estimateFileSizeFromBase64('')).toBe(0);
    });

    it('should handle large base64 strings', () => {
      // Create a 1000-character base64 string
      const base64 = 'A'.repeat(1000);
      const estimatedSize = estimateFileSizeFromBase64(base64);

      // 1000 chars * 6 bits / 8 = 750 bytes
      expect(estimatedSize).toBe(750);
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(formatFileSize(0)).toBe('0.00 B');
      expect(formatFileSize(100)).toBe('100.00 B');
      expect(formatFileSize(1023)).toBe('1023.00 B');
    });

    it('should format kilobytes correctly', () => {
      expect(formatFileSize(1024)).toBe('1.00 KB');
      expect(formatFileSize(2048)).toBe('2.00 KB');
      expect(formatFileSize(1536)).toBe('1.50 KB');
    });

    it('should format megabytes correctly', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.00 MB');
      expect(formatFileSize(1024 * 1024 * 2)).toBe('2.00 MB');
      expect(formatFileSize(1024 * 1024 * 1.5)).toBe('1.50 MB');
    });

    it('should format gigabytes correctly', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.00 GB');
      expect(formatFileSize(1024 * 1024 * 1024 * 2)).toBe('2.00 GB');
      expect(formatFileSize(1024 * 1024 * 1024 * 1.5)).toBe('1.50 GB');
    });

    it('should handle fractional sizes', () => {
      expect(formatFileSize(1500)).toBe('1.46 KB');
      expect(formatFileSize(1024 * 1024 + 512 * 1024)).toBe('1.50 MB');
    });

    it('should not go beyond GB', () => {
      const terabyte = 1024 * 1024 * 1024 * 1024;
      const result = formatFileSize(terabyte);
      expect(result).toContain('GB');
    });
  });
});
