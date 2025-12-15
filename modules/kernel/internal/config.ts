import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

let envLoaded = false;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function loadRootDotenv(): void {
  if (envLoaded) return;
  
  let current = moduleDir;
  while (current !== path.dirname(current)) {
    const dotenvPath = path.join(current, '.env');
    if (fs.existsSync(dotenvPath)) {
      dotenvConfig({ path: dotenvPath, override: false });
      envLoaded = true;
      return;
    }
    current = path.dirname(current);
  }
  envLoaded = true;
}

export function substituteEnv(value: any): any {
  loadRootDotenv();
  
  if (typeof value === 'string') {
    const envPattern = /\$\{([A-Z0-9_?]+)\}/g;
    return value.replace(envPattern, (match, token) => {
      const optional = token.endsWith('?');
      const envVar = optional ? token.slice(0, -1) : token;
      
      if (envVar in process.env) {
        return process.env[envVar] || '';
      }
      
      if (optional) {
        return '';
      }
      
      throw new Error(`Environment variable '${envVar}' required but not set`);
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
  const data = JSON.parse(content);
  return substituteEnv(data);
}
