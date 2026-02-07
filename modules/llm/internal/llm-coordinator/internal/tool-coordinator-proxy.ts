import type { LLMCallSpec, PluginRegistry, VectorContextConfig } from '../../../../../kernel/index.js';

export interface PendingVectorContexts {
  configs: VectorContextConfig[] | undefined;
  aliasMaps?: Record<string, Record<string, string>>;
}

export function createToolCoordinatorProxy(options: {
  getRegistry: () => PluginRegistry;
  getToolCoordinatorImpl: () => any;
  setPendingVectorContexts: (pending: PendingVectorContexts | undefined) => void;
  getActiveToolSpec: () => LLMCallSpec | undefined;
  ensureToolCoordinator: (spec: LLMCallSpec) => Promise<any>;
}): any {
  return {
    __isToolCoordinatorProxy: true,
    setVectorContexts: (
      configs: VectorContextConfig[] | undefined,
      _registry?: PluginRegistry,
      aliasMaps?: Record<string, Record<string, string>>
    ) => {
      const impl = options.getToolCoordinatorImpl();
      if (!impl) {
        options.setPendingVectorContexts({ configs, aliasMaps });
        return;
      }
      impl.setVectorContexts?.(configs, options.getRegistry(), aliasMaps);
    },
    routeAndInvoke: async (toolName: string, callId: string, args: any, context: any) => {
      let impl = options.getToolCoordinatorImpl();
      if (!impl) {
        const activeSpec = options.getActiveToolSpec();
        if (!activeSpec) {
          throw new Error('ToolCoordinator not initialized (no active spec)');
        }
        await options.ensureToolCoordinator(activeSpec);
        impl = options.getToolCoordinatorImpl();
      }
      return impl.routeAndInvoke(toolName, callId, args, context);
    },
    close: async () => {
      await options.getToolCoordinatorImpl()?.close?.();
    }
  };
}
