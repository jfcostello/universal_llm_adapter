import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '../..');
export const DIST_DIR = path.join(ROOT_DIR, 'dist');
export const FIXTURES_DIR = path.join(ROOT_DIR, 'tests', 'fixtures');

export function getTmpRoot(): string {
  const root = (globalThis as any).__LLM_ADAPTER_TS_TMP_ROOT__;
  if (!root) {
    throw new Error('Temporary root not initialised. Ensure jest-setup.ts ran.');
  }
  return root;
}

export function resolveFixture(...segments: string[]): string {
  return path.join(FIXTURES_DIR, ...segments);
}
