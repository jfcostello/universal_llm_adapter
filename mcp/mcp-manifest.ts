import { JsonObject, MCPServerConfig } from '../core/types.js';
import { ManifestError } from '../core/errors.js';

type RawServerConfig = Partial<MCPServerConfig> & {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  description?: unknown;
  autoStart?: unknown;
  capabilities?: unknown;
  requestTimeoutMs?: unknown;
};

type RawManifest =
  | {
      mcpServers: Record<string, RawServerConfig>;
      [key: string]: unknown;
    }
  | Record<string, RawServerConfig>;

export function parseMCPManifest(manifest: unknown, sourceName: string): MCPServerConfig[] {
  if (!isPlainObject(manifest)) {
    throw new ManifestError(`MCP manifest '${sourceName}' must be a JSON object`);
  }

  const rawManifest = manifest as RawManifest;
  const serverMap: Record<string, RawServerConfig> =
    'mcpServers' in rawManifest
      ? validateServerMap(rawManifest.mcpServers, sourceName)
      : validateServerMap(rawManifest, sourceName);

  const servers: MCPServerConfig[] = [];

  for (const [id, rawConfig] of Object.entries(serverMap)) {
    const normalized = normalizeServerConfig(id, rawConfig, sourceName);
    servers.push(normalized);
  }

  if (!servers.length) {
    throw new ManifestError(`MCP manifest '${sourceName}' must define at least one server`);
  }

  return servers;
}

function normalizeServerConfig(id: string, raw: RawServerConfig, sourceName: string): MCPServerConfig {
  if (!raw || !isPlainObject(raw)) {
    throw new ManifestError(`MCP server '${id}' in '${sourceName}' must be an object`);
  }

  const command = validateCommand(raw.command, id, sourceName);
  const args = validateArgs(raw.args, id, sourceName);
  const env = validateEnv(raw.env, id, sourceName);
  const capabilities = validateJsonObject(raw.capabilities, 'capabilities', id, sourceName);

  const requestTimeoutMs =
    raw.requestTimeoutMs === undefined
      ? undefined
      : validateNumber(raw.requestTimeoutMs, 'requestTimeoutMs', id, sourceName);

  const autoStart =
    raw.autoStart === undefined
      ? undefined
      : validateBoolean(raw.autoStart, 'autoStart', id, sourceName);

  const description =
    raw.description === undefined
      ? undefined
      : validateString(raw.description, 'description', id, sourceName);

  return {
    id,
    command,
    args,
    env,
    description,
    autoStart,
    capabilities,
    requestTimeoutMs
  };
}

function validateServerMap(value: unknown, sourceName: string): Record<string, RawServerConfig> {
  if (!isPlainObject(value)) {
    throw new ManifestError(`MCP manifest '${sourceName}' must define servers as a JSON object`);
  }
  return value as Record<string, RawServerConfig>;
}

function validateCommand(value: unknown, id: string, sourceName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ManifestError(
      `MCP server '${id}' in '${sourceName}' must include a non-empty string 'command'`
    );
  }
  return value;
}

function validateArgs(value: unknown, id: string, sourceName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new ManifestError(
      `MCP server '${id}' in '${sourceName}' must define 'args' as an array of strings`
    );
  }
  return value;
}

function validateEnv(
  value: unknown,
  id: string,
  sourceName: string
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new ManifestError(
      `MCP server '${id}' in '${sourceName}' must define 'env' as an object`
    );
  }

  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== 'string') {
      throw new ManifestError(
        `MCP server '${id}' in '${sourceName}' must define environment variables as strings`
      );
    }
    result[key] = val;
  }

  return result;
}

function validateJsonObject(
  value: unknown,
  field: string,
  id: string,
  sourceName: string
): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new ManifestError(
      `MCP server '${id}' in '${sourceName}' must define '${field}' as an object`
    );
  }
  return value as JsonObject;
}

function validateNumber(value: unknown, field: string, id: string, sourceName: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ManifestError(
      `MCP server '${id}' in '${sourceName}' must define '${field}' as a number`
    );
  }
  return value;
}

function validateBoolean(value: unknown, field: string, id: string, sourceName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ManifestError(
      `MCP server '${id}' in '${sourceName}' must define '${field}' as a boolean`
    );
  }
  return value;
}

function validateString(value: unknown, field: string, id: string, sourceName: string): string {
  if (typeof value !== 'string') {
    throw new ManifestError(
      `MCP server '${id}' in '${sourceName}' must define '${field}' as a string`
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
