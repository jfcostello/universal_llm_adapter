import { PluginRegistry } from '../../../core/registry.js';
import type { PluginRegistryLike, RunLifecycleOptions } from './types.js';

const defaultPluginsPath = './plugins';

export async function runWithCoordinatorLifecycle<S, R extends PluginRegistryLike, C, T>(
  options: RunLifecycleOptions<S, R, C, T>
): Promise<T> {
  const {
    spec,
    pluginsPath = defaultPluginsPath,
    registry,
    batchId,
    closeLoggerAfter = true,
    deps,
    run
  } = options;

  if (batchId !== undefined) {
    process.env.LLM_ADAPTER_BATCH_ID = String(batchId);
  }

  const createRegistry =
    deps.createRegistry ??
    ((path: string) => new PluginRegistry(path) as unknown as R);

  const lifecycleRegistry = registry ?? (await createRegistry(pluginsPath));

  if (typeof lifecycleRegistry.loadAll === 'function') {
    await lifecycleRegistry.loadAll();
  }

  let coordinator: any;
  let result: T | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;

  try {
    coordinator = await deps.createCoordinator(lifecycleRegistry);
    result = await run(coordinator as C, spec);
  } catch (error) {
    primaryError = error;
  } finally {
    if (coordinator && typeof coordinator.close === 'function') {
      try {
        await coordinator.close();
      } catch (error) {
        cleanupError = error;
      }
    }

    if (closeLoggerAfter) {
      const closeLogger =
        deps.closeLogger ??
        (await import('../../../core/logging.js')).closeLogger;
      try {
        await closeLogger();
      } catch (error) {
        if (!cleanupError) cleanupError = error;
      }
    }
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;

  return result as T;
}

