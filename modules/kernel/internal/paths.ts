import path from 'path';
import { fileURLToPath } from 'url';

const internalDir = path.dirname(fileURLToPath(import.meta.url));

// `modules/kernel/internal` -> repo/dist root (3 levels up)
export const PACKAGE_ROOT = path.resolve(internalDir, '..', '..', '..');

