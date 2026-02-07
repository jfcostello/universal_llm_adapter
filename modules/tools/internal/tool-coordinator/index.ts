import { spawn } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';
import axios from 'axios';
import { ProcessRouteManifest, VectorContextConfig, ToolExecutionError, getDefaults } from '../../../../kernel/index.js';
import type { PluginRegistry } from '../../../../kernel/index.js';
import type { MCPClientPool } from '../../../mcp/index.js';
import { invokeCommand as invokeCommandImpl } from './internal/invoke-command.js';
import { resolveInvokeModulePath } from './internal/resolve-invoke-module-path.js';
import { createTimeout as createTimeoutImpl } from './internal/timeout.js';
import type { ToolContext, ToolRouteAndInvokeContext } from './internal/types.js';
import { compileMatcher } from './internal/matcher.js';
import {
  computeVectorSearchState,
  getVectorSearchEntryForToolName,
  translateVectorSearchArgs as translateVectorSearchArgsImpl,
  type VectorSearchEntry
} from './internal/vector-search.js';
import { closeVectorRuntime, ensureVectorRuntime, type VectorRuntimeState } from './internal/vector-runtime.js';

export interface ToolCoordinatorOptions {
  vectorContexts?: VectorContextConfig[];
  registry?: PluginRegistry;
  vectorSearchAliasMaps?: Record<string, Record<string, string>>;
}

export class ToolCoordinator {
  private mcpServerIds: string[] = [];
  private registry?: PluginRegistry;
  private vectorContextsByToolName = new Map<string, VectorSearchEntry>();
  private vectorRuntime: VectorRuntimeState = {};
  private warnedInvokeModuleCwdFallback = new Set<string>();
  private routesById = new Map<string, ProcessRouteManifest>();
  private compiledRoutes: Array<{ route: ProcessRouteManifest; match: (toolName: string) => boolean }> = [];
  private compiledToolIdRoutes: Array<{ route: ProcessRouteManifest; match: (toolId: string) => boolean }> = [];

  constructor(
    private routes: ProcessRouteManifest[],
    private mcpPool?: MCPClientPool,
    options?: ToolCoordinatorOptions
  ) {
    if (mcpPool) {
      this.mcpServerIds = mcpPool.getServerIds();
    }

    this.registry = options?.registry;
    if (options?.vectorContexts && options.vectorContexts.length > 0) {
      this.setVectorContexts(options.vectorContexts, this.registry, options.vectorSearchAliasMaps);
    }

    this.routesById = new Map(routes.map(route => [route.id, route]));
    this.compiledRoutes = routes.map((route) => ({ route, match: compileMatcher(route.match) }));
    this.compiledToolIdRoutes = routes
      .filter(route => !!route.matchToolId)
      .map(route => ({ route, match: compileMatcher(route.matchToolId!) }));
  }

  protected createTimeout(
    seconds: number,
    options?: {
      signal?: AbortSignal;
      onTimeout?: () => void;
    }
  ): Promise<never> {
    return createTimeoutImpl(seconds, options);
  }

  setVectorContexts(
    configs: VectorContextConfig[] | undefined,
    registry?: PluginRegistry,
    aliasMaps?: Record<string, Record<string, string>>
  ): void {
    if (registry) {
      this.registry = registry;
    }

    this.vectorContextsByToolName = computeVectorSearchState(configs, aliasMaps);
  }

  private isVectorSearchTool(toolName: string): boolean {
    return !!this.getVectorSearchEntry(toolName);
  }

  async routeAndInvoke(
    toolName: string,
    callId: string,
    args: any,
    context: ToolRouteAndInvokeContext
  ): Promise<any> {
    const vectorEntry = this.getVectorSearchEntry(toolName);
    if (vectorEntry) {
      return this.invokeVectorSearch(toolName, callId, args, context, vectorEntry);
    }

    const route = this.selectRoute(toolName, { processRouteId: context.processRouteId, toolId: context.toolId });
    if (!route) {
      throw new ToolExecutionError(`No matching process route for tool '${toolName}'`);
    }

    const ctx: ToolContext = {
      toolName,
      callId,
      args,
      provider: context.provider,
      model: context.model,
      metadata: context.metadata || {},
      callProgress: context.callProgress
    };
    if (context.callProgress && typeof context.callProgress === 'object' && !Array.isArray(context.callProgress)) {
      (context.callProgress as any).routeId = route.id;
      (context.callProgress as any).invokeKind = route.invoke.kind;
    }

    if (context.logger) {
      const logFields: any = {
        toolName,
        callId,
        routeId: route.id,
        invokeKind: route.invoke.kind
      };
      if (context.callProgress && typeof context.callProgress === 'object' && !Array.isArray(context.callProgress)) {
        Object.assign(logFields, context.callProgress);
      }
      context.logger.debug?.('Routing tool call', logFields);
    }

    const timeoutMs = route.timeoutMs ?? getDefaults().tools.timeoutMs;
    const timeoutSeconds = timeoutMs / 1000;
    const timeoutCancel = new AbortController();
    const invokeAbort = new AbortController();

    try {
      const result = await Promise.race([
        this.invoke(route, ctx, { signal: invokeAbort.signal }),
        this.createTimeout(timeoutSeconds, {
          signal: timeoutCancel.signal,
          onTimeout: () => invokeAbort.abort()
        })
      ]);

      return result;
    } catch (error: any) {
      throw new ToolExecutionError(`Process route '${route.id}' failed: ${error.message}`);
    } finally {
      timeoutCancel.abort();
    }
  }

  private getVectorSearchEntry(toolName: string): VectorSearchEntry | undefined {
    return getVectorSearchEntryForToolName({
      toolName,
      byToolName: this.vectorContextsByToolName
    });
  }

  private translateVectorSearchArgs(args: Record<string, any>, aliasMap?: Record<string, string>): Record<string, any> {
    return translateVectorSearchArgsImpl(args, aliasMap);
  }

  private async invokeVectorSearch(
    toolName: string,
    callId: string,
    args: any,
    context: ToolRouteAndInvokeContext,
    entry: VectorSearchEntry
  ): Promise<any> {
    if (!this.registry) {
      throw new ToolExecutionError('Vector search not configured');
    }

    const translatedArgs = this.translateVectorSearchArgs(args, entry.aliasMap);

    context.logger?.info('Invoking built-in vector_search handler', {
      toolName,
      callId,
      hasLocks: !!entry.config.locks,
      lockedParams: Object.keys(entry.config.locks ?? {}),
      hasAliasMap: !!entry.aliasMap
    });

    const { executeVectorSearch, formatVectorSearchResults } = await import('../../../vector/index.js');
    const runtime = await ensureVectorRuntime(this.vectorRuntime, this.registry);

    const result = await executeVectorSearch(
      {
        query: translatedArgs.query,
        topK: translatedArgs.topK,
        store: translatedArgs.store,
        filter: translatedArgs.filter,
        collection: translatedArgs.collection,
        scoreThreshold: translatedArgs.scoreThreshold
      },
      {
        vectorConfig: entry.config,
        registry: this.registry,
        logger: context.logger,
        embeddingManager: runtime.embeddingManager,
        vectorManager: runtime.vectorManager
      }
    );

    const formattedResult = formatVectorSearchResults(result, entry.config);
    return { result: formattedResult };
  }

  private selectRoute(toolName: string, options?: { processRouteId?: string; toolId?: string }): ProcessRouteManifest | undefined {
    const processRouteId = options?.processRouteId;
    if (processRouteId) {
      const routed = this.routesById.get(processRouteId);
      if (!routed) {
        throw new ToolExecutionError(`No process route found for id '${processRouteId}'`);
      }
      return routed;
    }

    const toolId = options?.toolId;
    if (toolId) {
      const routedById = this.routesById.get(toolId);
      if (routedById) {
        return routedById;
      }
      for (const compiled of this.compiledToolIdRoutes) {
        if (compiled.match(toolId)) {
          return compiled.route;
        }
      }
    }

    for (const compiled of this.compiledRoutes) {
      if (compiled.match(toolName)) {
        return compiled.route;
      }
    }
    if (this.mcpPool && this.mcpServerIds.length > 0) {
      for (const serverId of this.mcpServerIds) {
        if (toolName.startsWith(`${serverId}.`) || toolName.startsWith(`${serverId}_`)) {
          return {
            id: `mcp-${serverId}`,
            match: { type: 'prefix', pattern: serverId },
            invoke: { kind: 'mcp', server: serverId }
          };
        }
      }
    }

    return undefined;
  }

  private async invoke(
    route: ProcessRouteManifest,
    ctx: ToolContext,
    options: { signal?: AbortSignal } = {}
  ): Promise<any> {
    switch (route.invoke.kind) {
      case 'module':
        return this.invokeModule(route, ctx, options);
      case 'http':
        return this.invokeHttp(route, ctx, options);
      case 'command':
        return this.invokeCommand(route, ctx, options);
      case 'mcp':
        return this.invokeMcp(route, ctx);
      default:
        throw new ToolExecutionError(`Unsupported invoke kind '${route.invoke.kind}'`);
    }
  }

  private async invokeModule(route: ProcessRouteManifest, ctx: ToolContext, options: { signal?: AbortSignal }): Promise<any> {
    if (!route.invoke.module) {
      throw new ToolExecutionError('Module route missing module field');
    }

    const modulePath = this.resolveInvokeModulePath(route, route.invoke.module);
    const module = await this.loadModule(modulePath);
    const fn = route.invoke.function || 'handle';
    const handler = module[fn] || module.default || module;

    const invocationCtx = options.signal ? { ...ctx, abortSignal: options.signal } : ctx;
    const invocation = await handler(invocationCtx);
    if (invocation && typeof invocation === 'object' && 'result' in invocation) {
      return invocation;
    }
    return { result: invocation };
  }

  private async invokeHttp(route: ProcessRouteManifest, ctx: ToolContext, options: { signal?: AbortSignal }): Promise<any> {
    if (!route.invoke.url) {
      throw new ToolExecutionError('HTTP route missing url');
    }

    const response = await axios.request({
      method: route.invoke.method || 'POST',
      url: route.invoke.url,
      headers: route.invoke.headers || {},
      data: ctx,
      signal: options.signal
    });

    return response.data || { result: null };
  }

  private async invokeCommand(route: ProcessRouteManifest, ctx: ToolContext, options: { signal?: AbortSignal }): Promise<any> {
    if (!route.invoke.command) {
      throw new ToolExecutionError('Command route missing command');
    }

    return invokeCommandImpl({
      route,
      ctx,
      signal: options.signal,
      spawnProcess: (command, args, spawnOptions) => this.spawnProcess(command, args, spawnOptions)
    });
  }

  private async invokeMcp(route: ProcessRouteManifest, ctx: ToolContext): Promise<any> {
    if (!this.mcpPool) {
      throw new ToolExecutionError('MCP route requested but no pool configured');
    }

    if (!route.invoke.server) {
      throw new ToolExecutionError('MCP route missing server');
    }

    const result = await this.mcpPool.call(route.invoke.server, ctx.toolName, ctx.args);
    return { result };
  }

  protected async loadModule(modulePath: string): Promise<any> {
    if (modulePath.startsWith('file:') || modulePath.startsWith('node:')) {
      return import(modulePath);
    }
    if (path.isAbsolute(modulePath)) {
      return import(pathToFileURL(modulePath).href);
    }
    return import(modulePath);
  }

  private resolveInvokeModulePath(route: ProcessRouteManifest, moduleSpecifier: string): string {
    return resolveInvokeModulePath({
      registry: this.registry,
      route,
      moduleSpecifier,
      warnedInvokeModuleCwdFallback: this.warnedInvokeModuleCwdFallback
    });
  }

  protected spawnProcess(command: string, args: string[], options: any) {
    return spawn(command, args, options);
  }

  async close(): Promise<void> {
    await closeVectorRuntime(this.vectorRuntime);
  }
}
