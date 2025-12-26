import path from 'path';
import { fileURLToPath } from 'url';

const internalDir = path.dirname(fileURLToPath(import.meta.url));

// `kernel/internal` -> repo root (or dist root) (2 levels up)
export const PACKAGE_ROOT = path.resolve(internalDir, '..', '..');
