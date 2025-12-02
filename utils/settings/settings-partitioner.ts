import {
  LLMCallSettings,
  RuntimeSettings,
  RUNTIME_SETTING_KEYS,
  PROVIDER_SETTING_KEYS
} from '../../core/types.js';

const runtimeKeySet = new Set<string>(RUNTIME_SETTING_KEYS);
const providerKeySet = new Set<string>(PROVIDER_SETTING_KEYS);

export interface PartitionedSettings {
  runtime: RuntimeSettings;
  provider: LLMCallSettings;
  providerExtras: Record<string, any>;
}

export function partitionSettings(settings: LLMCallSettings | undefined): PartitionedSettings {
  const runtime: RuntimeSettings = {};
  const provider: LLMCallSettings = {};
  const providerExtras: Record<string, any> = {};

  if (!settings) {
    return { runtime, provider, providerExtras };
  }

  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;

    if (runtimeKeySet.has(key)) {
      runtime[key as keyof RuntimeSettings] = value as any;
      continue;
    }

    provider[key as keyof LLMCallSettings] = value;

    if (!providerKeySet.has(key)) {
      providerExtras[key] = value;
    }
  }

  return { runtime, provider, providerExtras };
}

export function mergeRuntimeSettings(
  target: RuntimeSettings,
  overrides?: RuntimeSettings
): RuntimeSettings {
  if (!overrides) return target;
  return { ...target, ...overrides };
}

/**
 * Deep merge per-provider settings into global settings.
 * Per-provider settings take precedence for specified fields.
 * - Nested objects (e.g., reasoning) are deep merged
 * - Arrays (e.g., stop) are replaced entirely
 * - Undefined values in perProvider are ignored
 *
 * @param globalSettings - The global settings from LLMCallSpec.settings
 * @param perProviderSettings - Optional per-provider overrides from LLMPriorityItem.settings
 * @returns Merged settings with per-provider values taking precedence
 */
export function mergeProviderSettings(
  globalSettings: LLMCallSettings,
  perProviderSettings?: Partial<LLMCallSettings>
): LLMCallSettings {
  if (!perProviderSettings) return globalSettings;

  const merged: LLMCallSettings = { ...globalSettings };

  for (const [key, value] of Object.entries(perProviderSettings)) {
    if (value === undefined) continue;

    const globalValue = merged[key as keyof LLMCallSettings];

    // Deep merge for plain objects (not arrays, not null)
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof globalValue === 'object' &&
      globalValue !== null &&
      !Array.isArray(globalValue)
    ) {
      merged[key as keyof LLMCallSettings] = {
        ...(globalValue as Record<string, any>),
        ...(value as Record<string, any>)
      } as any;
    } else {
      // Shallow override for primitives, arrays, and null
      merged[key as keyof LLMCallSettings] = value as any;
    }
  }

  return merged;
}
