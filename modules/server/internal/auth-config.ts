import type { AuthConfig } from '../../auth/index.js';
import { readTrimmedStringProperty } from '../../shared/index.js';

function parseApiKeyEntriesFromEnv(env: NodeJS.ProcessEnv): Array<{ id: string; token?: string; sha256?: string }> {
  const raw = readTrimmedStringProperty(env, 'LLM_ADAPTER_API_KEYS');
  if (!raw) return [];

  const entries = raw
    .split(',')
    .map((v) => String(v).trim())
    .filter(Boolean);

  const keys: Array<{ id: string; token?: string; sha256?: string }> = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const match = entry.match(/^([^:=]{1,128})[:=](.+)$/);
    const id = match ? match[1].trim() : `key_${i + 1}`;
    const value = match ? match[2].trim() : entry.trim();

    if (/^sha256:/i.test(value) || /^[0-9a-f]{64}$/i.test(value)) {
      keys.push({ id, sha256: value });
    } else {
      keys.push({ id, token: value });
    }
  }

  return keys;
}

export function resolveAuthConfig(optionsAuth: unknown, authDefaults: unknown): AuthConfig {
  const candidate: any = optionsAuth ?? authDefaults;

  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid auth config');
  }

  if ('enabled' in candidate) {
    throw new Error('auth.enabled is no longer supported; use auth.mode');
  }
  if ('allowApiKeyHeader' in candidate) {
    throw new Error('allowApiKeyHeader is no longer supported; use allowHeader');
  }
  if (!candidate.mode) {
    throw new Error('Auth mode is required');
  }
  const mode = String(candidate.mode);
  if (mode === 'none') return { mode: 'none' };

  if (mode === 'apiKey') {
    const keys =
      Array.isArray(candidate.keys) && candidate.keys.length > 0
        ? candidate.keys
        : parseApiKeyEntriesFromEnv(process.env);
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error('apiKey auth requires at least one key (set LLM_ADAPTER_API_KEYS or auth.keys)');
    }

    return {
      mode: 'apiKey',
      allowBearer: candidate.allowBearer,
      allowHeader: candidate.allowHeader,
      headerName: candidate.headerName,
      realm: candidate.realm,
      keys
    } as any;
  }

  if (mode === 'jwt') {
    return { ...candidate, mode: 'jwt' } as any;
  }

  if (mode === 'proxySigned') {
    return { ...candidate, mode: 'proxySigned' } as any;
  }

  throw new Error(`Unsupported auth mode: ${mode}`);
}
