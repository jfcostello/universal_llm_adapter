import { getExtensionPluginRoots } from '../../../../../modules/extensions/index.js';

/**
 * All plugin roots for the voice extension, in priority order.
 * Callers should iterate through these roots to find their files.
 */
export const VOICE_EXTENSION_PLUGIN_ROOTS = getExtensionPluginRoots('voice');
