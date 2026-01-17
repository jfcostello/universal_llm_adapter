import { spawn } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

import axios from 'axios';
import { Minimatch } from 'minimatch';

import { ProcessRouteManifest, VectorContextConfig, ToolExecutionError, getDefaults } from '../../../../kernel/index.js';
import type { PluginRegistry } from '../../../../kernel/index.js';
import type { MCPClientPool } from '../../../mcp/index.js';

import { invokeCommand as invokeCommandImpl } from './internal/invoke-command.js';
import { resolveInvokeModulePath } from './internal/resolve-invoke-module-path.js';
import { createTimeout as createTimeoutImpl } from './internal/timeout.js';
import type { ToolContext, ToolRouteAndInvokeContext } from './internal/types.js';

export interface ToolCoordinatorOptions {
  vectorContext?: VectorContextConfig;
  registry?: PluginRegistry;
  vectorSearchAliasMap?: Record<string, string>;
}

export class ToolCoordinator {
  private mcpServerIds: string[] = [];
  private vectorContext?: VectorContextConfig;
  private registry?: PluginRegistry;
  private vectorToolName: string = 'vector_search';
  private vectorSearchAliasMap?: Record<string, string>;
  private warnedInvokeModuleCwdFallback = new Set<string>();
  private compiledRoutes: Array<{ route: ProcessRouteManifest; match: (toolName: string) => boolean }> = [];

  constructor(
    private routes: ProcessRouteManifest[],
    private mcpPool?: MCPClientPool,
    options?: ToolCoordinatorOptions
  ) {
    if (mcpPool) {
      this.mcpServerIds = mcpPool.getServerIds();
    }

    if (options?.vectorContext) {
      this.vectorContext = options.vectorContext;
      this.vectorToolName = options.vectorContext.toolName ?? 'vector_search';
    }
    this.registry = options?.registry;
    this.vectorSearchAliasMap = options?.vectorSearchAliasMap;
    this.compiledRoutes = routes.map((route) => ({ route, match: this.compileRouteMatcher(route) }));
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

  private compileRouteMatcher(route: ProcessRouteManifest): (toolName: string) => boolean {
    const matchType = route.match.type;
    const pattern = route.match.pattern;

    switch (matchType) {
      case 'exact':
        return (toolName: string) => toolName === pattern;
      case 'prefix':
        return (toolName: string) => toolName.startsWith(pattern);
      case 'regex': {
        try {
          const regex = new RegExp(pattern);
          return (toolName: string) => regex.test(toolName);
        } catch (error: any) {
          return () => {
            throw error;
          };
        }
      }
      case 'glob': {
        try {
          const matcher = new Minimatch(pattern);
          return (toolName: string) => matcher.match(toolName);
        } catch (error: any) {
          return () => {
            throw error;
          };
        }
      }
      default:
        return () => false;
    }
  }

  setVectorContext(
    config: VectorContextConfig | undefined,
    registry?: PluginRegistry,
    aliasMap?: Record<string, string>
  ): void {
    this.vectorContext = config;
    if (config) {
      this.vectorToolName = config.toolName ?? 'vector_search';
    }
    if (registry) {
      this.registry = registry;
    }
    this.vectorSearchAliasMap = aliasMap;
  }

  async routeAndInvoke(
    toolName: string,
    callId: string,
    args: any,
    context: ToolRouteAndInvokeContext
  ): Promise<any> {
    if (this.isVectorSearchTool(toolName)) {
      return this.invokeVectorSearch(toolName, callId, args, context);
    }

    const route = this.selectRoute(toolName);
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

    if (context.logger) {
      const logFields: any = {
        toolName,
        callId,
        routeId: route.id,
        invokeKind: route.invoke.kind
      };

      if (context.callProgress) {
        Object.assign(logFields, context.callProgress);
      }

      context.logger.info('Routing tool call', logFields);
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

  private isVectorSearchTool(toolName: string): boolean {
    if (!this.vectorContext) return false;
    const mode = this.vectorContext.mode;
    if (mode !== 'tool' && mode !== 'both') return false;
    return toolName === this.vectorToolName;
  }

  private translateVectorSearchArgs(args: Record<string, any>): Record<string, any> {
    if (!this.vectorSearchAliasMap) {
      return args;
    }

    const translated: Record<string, any> = {};
    for (const [key, value] of Object.entries(args)) {
      const canonicalName = this.vectorSearchAliasMap[key] ?? key;
      translated[canonicalName] = value;
    }
    return translated;
  }

  private async invokeVectorSearch(
    toolName: string,
    callId: string,
    args: any,
    context: ToolRouteAndInvokeContext
  ): Promise<any> {
    if (!this.vectorContext || !this.registry) {
      throw new ToolExecutionError('Vector search not configured');
    }

    const translatedArgs = this.translateVectorSearchArgs(args);

    context.logger?.info('Invoking built-in vector_search handler', {
      toolName,
      callId,
      hasLocks: !!this.vectorContext.locks,
      lockedParams: Object.keys(this.vectorContext.locks ?? {}),
      hasAliasMap: !!this.vectorSearchAliasMap
    });

    const { executeVectorSearch, formatVectorSearchResults } = await import('../../../vector/index.js');

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
        vectorConfig: this.vectorContext,
        registry: this.registry,
        logger: context.logger
      }
    );

    const formattedResult = formatVectorSearchResults(result, this.vectorContext);
    return { result: formattedResult };
  }

  private selectRoute(toolName: string): ProcessRouteManifest | undefined {
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
        return this.invokeMcp(route, ctx, options);
      default:
        throw new ToolExecutionError(`Unsupported invoke kind '${route.invoke.kind}'`);
    }
  }

  private async invokeModule(
    route: ProcessRouteManifest,
    ctx: ToolContext,
    options: { signal?: AbortSignal }
  ): Promise<any> {
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

  private async invokeHttp(
    route: ProcessRouteManifest,
    ctx: ToolContext,
    options: { signal?: AbortSignal }
  ): Promise<any> {
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

  private async invokeCommand(
    route: ProcessRouteManifest,
    ctx: ToolContext,
    options: { signal?: AbortSignal }
  ): Promise<any> {
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

  private async invokeMcp(
    route: ProcessRouteManifest,
    ctx: ToolContext,
    _options: { signal?: AbortSignal }
  ): Promise<any> {
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
    // Cleanup if needed
  }
}
