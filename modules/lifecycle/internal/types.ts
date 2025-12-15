export interface PluginRegistryLike {
  loadAll?: () => Promise<void>;
}

export interface CoordinatorLifecycleDeps<R extends PluginRegistryLike, C> {
  createRegistry?: (pluginsPath: string) => PromiseLike<R> | R;
  createCoordinator: (registry: R) => PromiseLike<C> | C;
  closeLogger?: () => Promise<void>;
}

export interface BaseLifecycleOptions<S, R extends PluginRegistryLike, C> {
  spec: S;
  pluginsPath?: string;
  registry?: R;
  batchId?: string;
  closeLoggerAfter?: boolean;
  deps: CoordinatorLifecycleDeps<R, C>;
}

export interface RunLifecycleOptions<S, R extends PluginRegistryLike, C, T>
  extends BaseLifecycleOptions<S, R, C> {
  run: (coordinator: C, spec: S) => Promise<T>;
}

export interface StreamLifecycleOptions<S, R extends PluginRegistryLike, C, E>
  extends BaseLifecycleOptions<S, R, C> {
  stream: (coordinator: C, spec: S) => AsyncIterable<E>;
}

