import path from 'path';
import { fileURLToPath } from 'url';

const internalDir = path.dirname(fileURLToPath(import.meta.url));

export const VOICE_EXTENSION_ROOT = path.resolve(internalDir, '..');
export const VOICE_EXTENSION_PLUGINS_ROOT = path.join(VOICE_EXTENSION_ROOT, 'plugins');

