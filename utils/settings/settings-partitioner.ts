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
