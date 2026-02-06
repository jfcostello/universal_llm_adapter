import type { ObservabilityTargetSpec } from '../../../kernel/index.js';
import { readTrimmedStringProperty } from './read-trimmed-string-property.js';

const TRUE_FLAGS = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_FLAGS = new Set(['0', 'false', 'no', 'n', 'off']);

function parseEnabledFlag(value: unknown): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_FLAGS.has(normalized)) return true;
  if (FALSE_FLAGS.has(normalized)) return false;
  return undefined;
}

function readProviderId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseTargetEntry(value: unknown): ObservabilityTargetSpec | null {
  const fromString = readProviderId(value);
  if (fromString) return { provider: fromString };

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const provider = readProviderId(raw.provider);
  if (!provider) return null;

  const target: ObservabilityTargetSpec = { provider };

  if (raw.providerConfig && typeof raw.providerConfig === 'object' && !Array.isArray(raw.providerConfig)) {
    target.providerConfig = raw.providerConfig as Record<string, unknown>;
  }
  if (raw.export && typeof raw.export === 'object' && !Array.isArray(raw.export)) {
    target.export = raw.export as any;
  }

  for (const key of [
    'flushAt',
    'flushIntervalMs',
    'maxQueueSize',
    'maxAttempts',
    'baseDelayMs',
    'maxDelayMs',
    'timeoutMs',
    'maxAttributeValueBytes'
  ] as const) {
    if (raw[key] !== undefined) {
      (target as any)[key] = raw[key];
    }
  }

  return target;
}

function parseTargetsFromJson(raw: string): ObservabilityTargetSpec[] | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const targets = parsed.map(parseTargetEntry).filter(Boolean) as ObservabilityTargetSpec[];
      return targets.length > 0 ? targets : undefined;
    }
    const single = parseTargetEntry(parsed);
    return single ? [single] : undefined;
  } catch {
    return undefined;
  }
}

function parseTargetsFromCsv(raw: string): ObservabilityTargetSpec[] | undefined {
  const targets = raw
    .split(',')
    .map(entry => readProviderId(entry))
    .filter(Boolean)
    .map(provider => ({ provider }));
  return targets.length > 0 ? targets : undefined;
}

export function resolveObservabilityEnabled(
  specEnabled: unknown,
  defaultsEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (typeof specEnabled === 'boolean') return specEnabled;

  const envEnabled = parseEnabledFlag(readTrimmedStringProperty(env, 'LLM_ADAPTER_OBSERVABILITY_ENABLED'));
  if (typeof envEnabled === 'boolean') return envEnabled;

  return defaultsEnabled;
}

export function resolveObservabilityTargetsOverride(
  env: NodeJS.ProcessEnv = process.env
): ObservabilityTargetSpec[] | undefined {
  const raw = readTrimmedStringProperty(env, 'LLM_ADAPTER_OBSERVABILITY_TARGETS');
  if (!raw) return undefined;

  if (raw.startsWith('[') || raw.startsWith('{')) {
    return parseTargetsFromJson(raw);
  }

  return parseTargetsFromCsv(raw);
}
