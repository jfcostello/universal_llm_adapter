const TRUE_FLAGS = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_FLAGS = new Set(['0', 'false', 'no', 'n', 'off']);

function parseEnabledFlag(value: unknown): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_FLAGS.has(normalized)) return true;
  if (FALSE_FLAGS.has(normalized)) return false;
  return undefined;
}

function readTrimmedEnvString(
  env: NodeJS.ProcessEnv,
  key: string
): string | undefined {
  const raw = env?.[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveObservabilityEnabled(
  specEnabled: unknown,
  defaultsEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (typeof specEnabled === 'boolean') return specEnabled;

  const envEnabled = parseEnabledFlag(readTrimmedEnvString(env, 'LLM_ADAPTER_OBSERVABILITY_ENABLED'));
  if (typeof envEnabled === 'boolean') return envEnabled;

  return defaultsEnabled;
}

