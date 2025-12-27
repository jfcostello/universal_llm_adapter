import { PluginRegistry } from '../../../kernel/index.js';
import type { PluginRegistryLike, RunLifecycleOptions } from './types.js';

const defaultPluginsPath = './plugins';
const noopCloseLogger = async (): Promise<void> => {};

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

  // Optional: fail-fast plugin validation (opt-in for live runs / long-lived processes).
  if (String(process.env.LLM_ADAPTER_VALIDATE_PLUGINS || '').trim() === '1') {
    const registryAny = lifecycleRegistry as any;
    if (registryAny && typeof registryAny.validateAll === 'function') {
      const validatedKey = Symbol.for('llm_adapter_plugins_validated');
      if (registryAny[validatedKey] !== true) {
        await registryAny.validateAll();
        registryAny[validatedKey] = true;
      }
    }
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
        deps.closeLogger ?? noopCloseLogger;
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
