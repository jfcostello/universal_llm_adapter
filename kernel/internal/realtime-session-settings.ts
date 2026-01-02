import type { RealtimeSessionSettings } from './realtime-types.js';

type SettingValueType = 'number' | 'int' | 'string' | 'boolean';

export type RealtimeSessionSettingDefinition = {
  type: SettingValueType;
  aliases?: readonly string[];
};

function asPlainObject(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, any>;
}

function normalizeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const n = normalizeNumber(value);
  if (n === undefined) return undefined;
  const out = Math.floor(n);
  if (!Number.isFinite(out) || out <= 0) return undefined;
  return out;
}

function normalizeString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return undefined;
  }
  return undefined;
}

export function parseRealtimeSessionSettings(
  settings: unknown,
  definitions: Record<string, RealtimeSessionSettingDefinition>
): {
  values: RealtimeSessionSettings;
  unknownKeys: string[];
  invalidKeys: string[];
} {
  const obj = asPlainObject(settings);
  if (!obj) return { values: {}, unknownKeys: [], invalidKeys: [] };

  const aliasToKey = new Map<string, string>();
  for (const [key, def] of Object.entries(definitions)) {
    aliasToKey.set(key, key);
    for (const alias of def.aliases ?? []) {
      aliasToKey.set(alias, key);
    }
  }

  const values: RealtimeSessionSettings = {};
  const unknownKeys: string[] = [];
  const invalidKeys: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const key = aliasToKey.get(rawKey);
    if (!key) {
      unknownKeys.push(rawKey);
      continue;
    }

    const def = definitions[key];
    if (!def) {
      unknownKeys.push(rawKey);
      continue;
    }

    if (def.type === 'string') {
      const v = normalizeString(rawValue);
      if (v !== undefined) {
        values[key] = v;
      } else if (rawValue !== undefined && rawValue !== null) {
        invalidKeys.push(rawKey);
      }
      continue;
    }

    if (def.type === 'boolean') {
      const v = normalizeBoolean(rawValue);
      if (v !== undefined) {
        values[key] = v;
      } else if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
        invalidKeys.push(rawKey);
      }
      continue;
    }

    if (def.type === 'int') {
      const v = normalizePositiveInt(rawValue);
      if (v !== undefined) {
        values[key] = v;
      } else if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
        invalidKeys.push(rawKey);
      }
      continue;
    }

    const v = normalizeNumber(rawValue);
    if (v !== undefined) {
      values[key] = v;
    } else if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
      invalidKeys.push(rawKey);
    }
  }

  return { values, unknownKeys, invalidKeys };
}
