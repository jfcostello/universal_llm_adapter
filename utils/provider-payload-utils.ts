import {
  ProviderManifest,
  ProviderPayloadExtension,
  JsonValue
} from '../core/types.js';
import { ProviderPayloadError } from '../core/errors.js';

export function applyProviderPayloadExtensions(
  provider: ProviderManifest,
  payload: any,
  settingsExtra?: Record<string, any>
): [any, Record<string, any>] {
  const normalizedPayload = JSON.parse(JSON.stringify(payload));
  const remainingExtra = { ...(settingsExtra || {}) };
  
  for (const extension of (provider.payloadExtensions || [])) {
    const valuePresent = extension.settingsKey in remainingExtra;
    let value = valuePresent ? remainingExtra[extension.settingsKey] : null;
    
    if (valuePresent) {
      delete remainingExtra[extension.settingsKey];
    }
    
    const hasDefault = Object.prototype.hasOwnProperty.call(extension, 'default');
    const defaultValue = hasDefault ? extension.default : undefined;

    if (value === null) {
      if (!hasDefault || defaultValue === undefined) {
        if (extension.required) {
          throw new ProviderPayloadError(
            `[${provider.id}] Missing required payload option '${extension.settingsKey}' for '${extension.name}'`
          );
        }
        continue;
      }

      if (defaultValue === null) {
        if (extension.required) {
          throw new ProviderPayloadError(
            `[${provider.id}] Missing required payload option '${extension.settingsKey}' for '${extension.name}'`
          );
        }
        continue;
      }

      value = JSON.parse(JSON.stringify(defaultValue));
    } else if (hasDefault && defaultValue !== undefined && defaultValue !== null) {
      value = mergeWithDefault(defaultValue as JsonValue, value);
    }
    
    validateExtensionValue(provider.id, extension, value);
    applyExtension(normalizedPayload, extension, value);
  }
  
  return [normalizedPayload, remainingExtra];
}

function applyExtension(
  payload: any,
  extension: ProviderPayloadExtension,
  value: any
): void {
  const [targetContainer, finalKey] = resolveTargetPath(payload, extension.targetPath);
  
  if (extension.mergeStrategy === 'replace' || !(finalKey in targetContainer)) {
    targetContainer[finalKey] = JSON.parse(JSON.stringify(value));
    return;
  }
  
  const existing = targetContainer[finalKey];
  if (typeof existing === 'object' && typeof value === 'object' && 
      !Array.isArray(existing) && !Array.isArray(value)) {
    targetContainer[finalKey] = deepMergeDicts(existing, value);
  } else {
    targetContainer[finalKey] = JSON.parse(JSON.stringify(value));
  }
}

function resolveTargetPath(payload: any, path: string[]): [any, string] {
  if (!path || path.length === 0) {
    throw new ProviderPayloadError('Target path for provider payload extension cannot be empty');
  }
  
  let current = payload;
  for (const key of path.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  
  return [current, path[path.length - 1]];
}

function deepMergeDicts(base: any, updates: any): any {
  const merged = { ...base };
  
  for (const [key, value] of Object.entries(updates)) {
    if (key in merged && typeof merged[key] === 'object' && typeof value === 'object' &&
        !Array.isArray(merged[key]) && !Array.isArray(value)) {
      merged[key] = deepMergeDicts(merged[key], value);
    } else {
      merged[key] = JSON.parse(JSON.stringify(value));
    }
  }
  
  return merged;
}

function mergeWithDefault(defaultValue: JsonValue, value: any): any {
  if (typeof defaultValue === 'object' && typeof value === 'object' &&
      !Array.isArray(defaultValue) && !Array.isArray(value)) {
    return deepMergeDicts(defaultValue, value);
  }
  return JSON.parse(JSON.stringify(value));
}

function validateExtensionValue(
  providerId: string,
  extension: ProviderPayloadExtension,
  value: any
): void {
  const expected = extension.valueType;
  if (expected === 'any') return;
  
  if (expected === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
    throw new ProviderPayloadError(
      `[${providerId}] Payload option '${extension.settingsKey}' must be an object`
    );
  }
  
  if (expected === 'array' && !Array.isArray(value)) {
    throw new ProviderPayloadError(
      `[${providerId}] Payload option '${extension.settingsKey}' must be an array`
    );
  }
  
  if (expected === 'string' && typeof value !== 'string') {
    throw new ProviderPayloadError(
      `[${providerId}] Payload option '${extension.settingsKey}' must be a string`
    );
  }
  
  if (expected === 'number' && typeof value !== 'number') {
    throw new ProviderPayloadError(
      `[${providerId}] Payload option '${extension.settingsKey}' must be a number`
    );
  }
  
  if (expected === 'boolean' && typeof value !== 'boolean') {
    throw new ProviderPayloadError(
      `[${providerId}] Payload option '${extension.settingsKey}' must be a boolean`
    );
  }
}
