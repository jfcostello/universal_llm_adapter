import type { JsonValue, ProviderManifest, ProviderPayloadExtension } from '../../../kernel/index.js';
import { ProviderPayloadError } from '../../../kernel/index.js';

function cloneJsonOrThrow(providerId: string, label: string, value: any): any {
  if (value === undefined) {
    return undefined;
  }

  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new Error('value is not JSON-serializable');
    }
    return JSON.parse(json);
  } catch {
    throw new ProviderPayloadError(`[${providerId}] ${label} must be JSON-serializable`);
  }
}

export function applyProviderPayloadExtensions(
  provider: ProviderManifest,
  payload: any,
  settingsExtra?: Record<string, any>
): [any, Record<string, any>] {
  const extensions = provider.payloadExtensions || [];
  const remainingExtra = { ...(settingsExtra || {}) };

  if (extensions.length === 0) {
    return [payload, remainingExtra];
  }

  let normalizedPayload = payload;
  let clonedPayload = false;

  for (const extension of extensions) {
    const valuePresent = Object.prototype.hasOwnProperty.call(remainingExtra, extension.settingsKey);
    let value = valuePresent ? remainingExtra[extension.settingsKey] : null;

    if (valuePresent) {
      delete remainingExtra[extension.settingsKey];
    }

    // Treat explicit undefined as missing (so defaults/required behavior applies and we don't attempt JSON cloning).
    if (value === undefined) {
      value = null;
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

      value = cloneJsonOrThrow(
        provider.id,
        `Default payload option '${extension.settingsKey}'`,
        defaultValue
      );
    } else if (hasDefault && defaultValue !== undefined && defaultValue !== null) {
      value = mergeWithDefault(provider.id, extension, defaultValue as JsonValue, value);
    }

    validateExtensionValue(provider.id, extension, value);

    if (!clonedPayload) {
      normalizedPayload = cloneJsonOrThrow(provider.id, 'Base payload', payload);
      clonedPayload = true;
    }
    applyExtension(normalizedPayload, provider.id, extension, value);
  }

  return [normalizedPayload, remainingExtra];
}

function applyExtension(
  payload: any,
  providerId: string,
  extension: ProviderPayloadExtension,
  value: any
): void {
  const [targetContainer, finalKey] = resolveTargetPath(payload, extension.targetPath);

  if (extension.mergeStrategy === 'replace' || !(finalKey in targetContainer)) {
    targetContainer[finalKey] = cloneJsonOrThrow(
      providerId,
      `Payload option '${extension.settingsKey}'`,
      value
    );
    return;
  }

  const existing = targetContainer[finalKey];
  if (
    typeof existing === 'object' &&
    typeof value === 'object' &&
    !Array.isArray(existing) &&
    !Array.isArray(value)
  ) {
    targetContainer[finalKey] = deepMergeDicts(providerId, extension, existing, value);
  } else {
    targetContainer[finalKey] = cloneJsonOrThrow(
      providerId,
      `Payload option '${extension.settingsKey}'`,
      value
    );
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

function deepMergeDicts(providerId: string, extension: ProviderPayloadExtension, base: any, updates: any): any {
  const merged = { ...base };

  for (const [key, value] of Object.entries(updates)) {
    if (
      key in merged &&
      typeof merged[key] === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(merged[key]) &&
      !Array.isArray(value)
    ) {
      merged[key] = deepMergeDicts(providerId, extension, merged[key], value);
    } else {
      merged[key] = cloneJsonOrThrow(
        providerId,
        `Payload option '${extension.settingsKey}'`,
        value
      );
    }
  }

  return merged;
}

function mergeWithDefault(
  providerId: string,
  extension: ProviderPayloadExtension,
  defaultValue: JsonValue,
  value: any
): any {
  if (
    typeof defaultValue === 'object' &&
    typeof value === 'object' &&
    !Array.isArray(defaultValue) &&
    !Array.isArray(value)
  ) {
    return deepMergeDicts(providerId, extension, defaultValue, value);
  }
  return cloneJsonOrThrow(providerId, `Payload option '${extension.settingsKey}'`, value);
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
