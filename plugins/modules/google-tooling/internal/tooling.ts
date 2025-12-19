import type { ToolChoice, UnifiedTool } from '../../../../modules/kernel/index.js';
import { sanitizeToolName } from '../../../../modules/kernel/index.js';

/**
 * Convert JSON Schema to Google parameters format.
 */
export function convertSchemaToGoogleFormat(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return { type: 'OBJECT', properties: {} };
  }

  const out: any = {};

  // Map type with Google's enum format
  if (schema.type) {
    const typeMap: any = {
      string: 'STRING',
      number: 'NUMBER',
      integer: 'INTEGER',
      boolean: 'BOOLEAN',
      array: 'ARRAY',
      object: 'OBJECT'
    };
    out.type = typeMap[schema.type] || String(schema.type).toUpperCase();
  }

  if (schema.description) out.description = schema.description;

  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      out.properties[propName] = convertSchemaToGoogleFormat(propSchema);
    }
  }

  if (Array.isArray(schema.required)) {
    out.required = schema.required.slice();
  }

  if (schema.items) {
    out.items = convertSchemaToGoogleFormat(schema.items);
  }

  if (Array.isArray(schema.enum)) {
    out.enum = schema.enum.slice();
  }

  if (typeof schema.minimum === 'number') out.minimum = schema.minimum;
  if (typeof schema.maximum === 'number') out.maximum = schema.maximum;
  if (typeof schema.format === 'string') out.format = schema.format;

  // Defaults
  if (out.type === 'OBJECT' && !out.properties) {
    out.properties = {};
  }

  if (!out.type && (out.properties || out.required)) {
    out.type = 'OBJECT';
  }

  return Object.keys(out).length ? out : { type: 'OBJECT', properties: {} };
}

/**
 * Convert tools to Google SDK `functionDeclarations` format.
 */
export function serializeToolsForSDK(tools: UnifiedTool[]): any {
  if (!tools || tools.length === 0) return undefined;

  const functionDeclarations = tools.map(t => ({
    name: sanitizeToolName(t.name),
    description: t.description || '',
    parameters: convertSchemaToGoogleFormat(t.parametersJsonSchema || {})
  }));

  return [{ functionDeclarations }];
}

/**
 * Convert tools to Google Live (bidi) `functionDeclarations` format.
 *
 * The Live API for the Gemini Developer endpoint expects function declarations to
 * use `parametersJsonSchema` (JSON Schema), rather than the `Schema` form used
 * in some non-live request/response APIs.
 */
export function serializeToolsForLiveSDK(tools: UnifiedTool[]): any {
  if (!tools || tools.length === 0) return undefined;

  const functionDeclarations = tools.map(t => ({
    name: sanitizeToolName(t.name),
    description: t.description || '',
    parametersJsonSchema: t.parametersJsonSchema || { type: 'object', properties: {} }
  }));

  return [{ functionDeclarations }];
}

/**
 * Convert tool choice to Google `functionCallingConfig`.
 */
export function serializeToolChoiceForSDK(choice?: ToolChoice, tools?: UnifiedTool[]): any {
  if (!choice) {
    // Default behavior: AUTO mode (model decides whether to call tools or respond with text)
    if (tools && tools.length > 0) {
      return {
        functionCallingConfig: {
          mode: 'AUTO'
        }
      };
    }
    return undefined;
  }

  if (typeof choice === 'string') {
    if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
    if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    return undefined;
  }

  if (choice.type === 'single') {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [sanitizeToolName(choice.name)]
      }
    };
  }

  if (choice.type === 'required') {
    const cfg: any = { mode: 'ANY' };
    if (choice.allowed && choice.allowed.length) {
      cfg.allowedFunctionNames = choice.allowed.map(sanitizeToolName);
    }
    return { functionCallingConfig: cfg };
  }

  return undefined;
}
