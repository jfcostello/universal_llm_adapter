import { getExtensionPaths } from '../../../../../kernel/index.js';

const { extensionRoot, pluginsRoot } = getExtensionPaths('voice');

export const VOICE_EXTENSION_ROOT = extensionRoot;
export const VOICE_EXTENSION_PLUGINS_ROOT = pluginsRoot;
