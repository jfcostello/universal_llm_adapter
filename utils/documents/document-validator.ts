/**
 * Basic validation utilities for documents.
 * Providers will do their own validation; these are just sanity checks.
 */

/**
 * Validate that base64 string is properly formatted.
 *
 * @param data - Base64 string to validate
 * @returns true if valid base64
 */
export function isValidBase64(data: string): boolean {
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  return base64Regex.test(data);
}

/**
 * Estimate the original file size from base64 string.
 * Base64 encoding increases size by ~33%.
 *
 * @param base64Data - Base64-encoded string
 * @returns Estimated original size in bytes
 */
export function estimateFileSizeFromBase64(base64Data: string): number {
  // Remove padding characters
  const withoutPadding = base64Data.replace(/=/g, '');
  // Each base64 character represents 6 bits
  // Original size = (base64 length * 6) / 8
  return Math.floor((withoutPadding.length * 6) / 8);
}

/**
 * Format file size for human-readable display.
 *
 * @param bytes - File size in bytes
 * @returns Formatted string (e.g., "1.5 MB")
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
