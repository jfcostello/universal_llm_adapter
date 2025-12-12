import { PluginRegistry } from '../../../core/registry.js';
import type { PluginRegistryLike, StreamLifecycleOptions } from './types.js';

const defaultPluginsPath = './plugins';

export async function* streamWithCoordinatorLifecycle<S, R extends PluginRegistryLike, C, E>(
  options: StreamLifecycleOptions<S, R, C, E>
): AsyncGenerator<E> {
  const {
    spec,
    pluginsPath = defaultPluginsPath,
    registry,
    batchId,
    closeLoggerAfter = true,
    deps,
    stream
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
  let primaryError: unknown;

  try {
    coordinator = await deps.createCoordinator(lifecycleRegistry);
    const iterator = stream(coordinator as C, spec)[Symbol.asyncIterator]();
    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;
      yield value;
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (coordinator && typeof coordinator.close === 'function') {
      try {
        await coordinator.close();
      } catch (error) {
        if (!primaryError) primaryError = error;
      }
    }

    if (closeLoggerAfter) {
      const closeLogger =
        deps.closeLogger ??
        (await import('../../../core/logging.js')).closeLogger;
      try {
        await closeLogger();
      } catch (error) {
        if (!primaryError) primaryError = error;
      }
    }
  }

  if (primaryError) throw primaryError;
}

