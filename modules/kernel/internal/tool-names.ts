import type { ToolChoice } from './types.js';

export function sanitizeToolName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  sanitized = sanitized || 'tool';

  if (sanitized.length > 64) {
    sanitized = sanitized.substring(0, 64);
  }

  return sanitized;
}

/**
 * Sanitize tool names within a ToolChoice object.
 * Applies the same sanitization used for tool definitions to ensure matching names.
 */
export function sanitizeToolChoice(choice: ToolChoice | undefined): ToolChoice | undefined {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;

  if (choice.type === 'single') {
    return {
      type: 'single',
      name: sanitizeToolName(choice.name)
    };
  }

  if (choice.type === 'required') {
    return {
      type: 'required',
      allowed: choice.allowed.map(sanitizeToolName)
    };
  }

  return choice;
}

