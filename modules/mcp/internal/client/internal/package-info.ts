import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type PackageInfo = { name: string; version: string };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function readPackageInfo(options?: { fallback?: PackageInfo }): PackageInfo {
  const fallback = options?.fallback ?? { name: 'llm-adapter', version: '1.0.0' };
  try {
    const packagePath = join(__dirname, '..', '..', '..', '..', '..', 'package.json');
    const packageData = JSON.parse(readFileSync(packagePath, 'utf-8'));
    return {
      name: packageData.name || fallback.name,
      version: packageData.version || fallback.version
    };
  } catch {
    return fallback;
  }
}

export const PACKAGE_INFO: PackageInfo = readPackageInfo();

