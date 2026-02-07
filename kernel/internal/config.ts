import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

let envLoaded = false;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

type EnvSubstitutionSpec =
  | { type: 'required'; envVar: string }
  | { type: 'optional'; envVar: string }
  | { type: 'default'; envVar: string; defaultValue: string };

function findPackageRoot(startDir: string): string {
  let current = startDir;
  while (current !== path.dirname(current)) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      return current;
    }
    current = path.dirname(current);
  }
  return startDir;
}

function loadRootDotenv(): void {
  if (envLoaded) return;

  // Bound dotenv lookup to this package root to avoid loading a parent repo env file.
  const packageRoot = findPackageRoot(moduleDir);

  let current = moduleDir;
  while (true) {
    const dotenvPath = path.join(current, '.env');
    if (fs.existsSync(dotenvPath)) {
      dotenvConfig({ path: dotenvPath, override: false });
      envLoaded = true;
      return;
    }

    if (current === packageRoot) {
      break;
    }
    current = path.dirname(current);
  }
  envLoaded = true;
}

function parseEnvSubstitutionToken(token: string): EnvSubstitutionSpec | null {
  const optionalMatch = token.match(/^([A-Z0-9_]+)\?$/);
  if (optionalMatch) {
    return { type: 'optional', envVar: optionalMatch[1] };
  }

  const defaultMatch = token.match(/^([A-Z0-9_]+):-([\s\S]*)$/);
  if (defaultMatch) {
    return { type: 'default', envVar: defaultMatch[1], defaultValue: defaultMatch[2] };
  }

  const requiredMatch = token.match(/^([A-Z0-9_]+)$/);
  if (requiredMatch) {
    return { type: 'required', envVar: requiredMatch[1] };
  }

  return null;
}

export function substituteEnv(value: any): any {
  loadRootDotenv();
  
  if (typeof value === 'string') {
    const envPattern = /\$\{([^}]+)\}/g;
    return value.replace(envPattern, (match, token) => {
      const spec = parseEnvSubstitutionToken(token);
      if (!spec) {
        return match;
      }

      const envValue = process.env[spec.envVar];

      if (spec.type === 'default') {
        if (typeof envValue !== 'string' || envValue === '') {
          return spec.defaultValue;
        }
        return envValue;
      }

      if (spec.type === 'optional') {
        return typeof envValue === 'string' ? envValue : '';
      }

      if (typeof envValue === 'string') {
        return envValue;
      }

      throw new Error(`Environment variable '${spec.envVar}' required but not set`);
    });
  }
  
  if (Array.isArray(value)) {
    return value.map(item => substituteEnv(item));
  }
  
  if (value && typeof value === 'object') {
    const result: any = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteEnv(val);
    }
    return result;
  }
  
  return value;
}

export function loadJsonFile(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');
  try {
    const data = JSON.parse(content);
    return substituteEnv(data);
  } catch (error: any) {
    const message = error?.message ? String(error.message) : String(error);
    const err = new Error(`Invalid JSON in file '${filePath}': ${message}`);
    (err as any).code = 'invalid_json';
    (err as any).filePath = filePath;
    throw err;
  }
}
