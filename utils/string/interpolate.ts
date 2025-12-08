/**
 * Template string interpolation utility.
 * Supports {{key}} and {{nested.key}} patterns for variable substitution.
 */

/**
 * Simple template interpolation.
 * Replaces {{key}} and {{nested.key}} patterns with values from the data object.
 *
 * @param template - The template string with {{placeholder}} patterns
 * @param data - The data object to interpolate values from
 * @returns The interpolated string with placeholders replaced by values
 *
 * @example
 * interpolate('Hello {{name}}!', { name: 'World' })
 * // Returns: 'Hello World!'
 *
 * @example
 * interpolate('{{payload.text}} (score: {{score}})', { score: 0.95, payload: { text: 'Result' } })
 * // Returns: 'Result (score: 0.95)'
 *
 * @example
 * // Missing keys return empty string
 * interpolate('{{missing}}', {})
 * // Returns: ''
 */
export function interpolate(template: string, data: Record<string, any>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const keys = key.trim().split('.');
    let value: any = data;

    for (const k of keys) {
      if (value === undefined || value === null) return '';
      value = value[k];
    }

    return value !== undefined && value !== null ? String(value) : '';
  });
}
