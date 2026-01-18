import { getAdapterPathsConfig } from '../../../kernel/index.js';
import { resolveEffectivePluginsPath } from '../../lifecycle/index.js';

export function resolvePluginsPathWithConfig(pluginsPath: string): string {
  const pathsConfig = getAdapterPathsConfig();
  return resolveEffectivePluginsPath({
    pluginsPath,
    configuredPluginsPath: pathsConfig?.paths.plugins
  });
}
