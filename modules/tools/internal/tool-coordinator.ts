import { spawn } from 'child_process';
import axios from 'axios';
import { minimatch } from 'minimatch';
import { ProcessRouteManifest, VectorContextConfig, ToolExecutionError, getDefaults } from '../../kernel/index.js';
import type { PluginRegistry } from '../../kernel/index.js';
import type { MCPClientPool } from '../../mcp/index.js';
import type { AdapterLogger } from '../../kernel/index.js';

interface ToolContext {
  toolName: string;
  callId: string;
  args: any;
  provider: string;
  model: string;
  metadata?: any;
  callProgress?: any;
}

export interface ToolCoordinatorOptions {
  /** Vector context configuration for built-in vector_search handling */
  vectorContext?: VectorContextConfig;
  /** Plugin registry for vector search operations */
  registry?: PluginRegistry;
  /** Maps exposed vector search param names -> canonical names for arg translation */
  vectorSearchAliasMap?: Record<string, string>;
}

export class ToolCoordinator {
  private mcpServerIds: string[] = [];
  private vectorContext?: VectorContextConfig;
  private registry?: PluginRegistry;
  private vectorToolName: string = 'vector_search';
  private vectorSearchAliasMap?: Record<string, string>;

  constructor(
    private routes: ProcessRouteManifest[],
    private mcpPool?: MCPClientPool,
    options?: ToolCoordinatorOptions
  ) {
    // Extract MCP server IDs from the pool
    if (mcpPool) {
      this.mcpServerIds = (mcpPool as any).servers?.map((s: any) => s.id) || [];
    }

    // Store vector context for built-in handling
    if (options?.vectorContext) {
      this.vectorContext = options.vectorContext;
      this.vectorToolName = options.vectorContext.toolName ?? 'vector_search';
    }
    this.registry = options?.registry;
    this.vectorSearchAliasMap = options?.vectorSearchAliasMap;
  }

  /**
   * Update vector context configuration.
   * Called when a new LLM call has different vector settings.
   */
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
    context: {
      provider: string;
      model: string;
      metadata?: any;
      logger?: AdapterLogger;
      callProgress?: any;
    }
  ): Promise<any> {
    // Check for built-in vector_search handling first
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
      // Ensure the timeout timer is cleared when unused.
      timeoutCancel.abort();
    }
  }

  /**
   * Check if a tool name matches the vector_search tool.
   */
  private isVectorSearchTool(toolName: string): boolean {
    if (!this.vectorContext) return false;

    // Check if the mode creates a vector_search tool
    const mode = this.vectorContext.mode;
    if (mode !== 'tool' && mode !== 'both') return false;

    // Match the configured tool name (default: 'vector_search')
    return toolName === this.vectorToolName;
  }

  /**
   * Translate aliased argument names to canonical names.
   * If no alias map is configured, returns args unchanged.
   */
  private translateVectorSearchArgs(args: Record<string, any>): Record<string, any> {
    if (!this.vectorSearchAliasMap) {
      return args;
    }

    const translated: Record<string, any> = {};
    for (const [key, value] of Object.entries(args)) {
      // Look up canonical name from alias map, or use the key as-is
      const canonicalName = this.vectorSearchAliasMap[key] ?? key;
      translated[canonicalName] = value;
    }
    return translated;
  }

  /**
   * Invoke built-in vector search handler with lock enforcement.
   */
  private async invokeVectorSearch(
    toolName: string,
    callId: string,
    args: any,
    context: {
      provider: string;
      model: string;
      metadata?: any;
      logger?: AdapterLogger;
      callProgress?: any;
    }
  ): Promise<any> {
    if (!this.vectorContext || !this.registry) {
      throw new ToolExecutionError('Vector search not configured');
    }

    // Translate aliased arg names to canonical names
    const translatedArgs = this.translateVectorSearchArgs(args);

    context.logger?.info('Invoking built-in vector_search handler', {
      toolName,
      callId,
      hasLocks: !!this.vectorContext.locks,
      lockedParams: Object.keys(this.vectorContext.locks ?? {}),
      hasAliasMap: !!this.vectorSearchAliasMap
    });

    // Lazy-load the handler to avoid importing vector code unless invoked.
    const { executeVectorSearch, formatVectorSearchResults } =
      await import('../../vector/index.js');

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

    // Format result for LLM consumption, passing config for resultFormat
    const formattedResult = formatVectorSearchResults(result, this.vectorContext);

    return { result: formattedResult };
  }

  private selectRoute(toolName: string): ProcessRouteManifest | undefined {
    // First check configured routes
    for (const route of this.routes) {
      const matchType = route.match.type;
      const pattern = route.match.pattern;

      switch (matchType) {
        case 'exact':
          if (toolName === pattern) return route;
          break;
        case 'prefix':
          if (toolName.startsWith(pattern)) return route;
          break;
        case 'regex':
          if (new RegExp(pattern).test(toolName)) return route;
          break;
        case 'glob':
          if (minimatch(toolName, pattern)) return route;
          break;
      }
    }

    // Check if this is an MCP tool (format: serverId.toolName or serverId_toolName)
    if (this.mcpPool && this.mcpServerIds.length > 0) {
      for (const serverId of this.mcpServerIds) {
        // Check both dot and underscore separators (due to sanitization)
        if (toolName.startsWith(`${serverId}.`) || toolName.startsWith(`${serverId}_`)) {
          // Create a virtual route for this MCP tool
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

    const modulePath = route.invoke.module.startsWith('.')
      ? `${process.cwd()}/${route.invoke.module}`
      : route.invoke.module;

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

    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...(route.invoke.env || {}) };

      const proc = this.spawnProcess(route.invoke.command!, route.invoke.args || [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const killProcess = () => {
        try {
          (proc as any).kill?.('SIGKILL');
        } catch {
          try {
            (proc as any).kill?.();
          } catch {
            // ignore
          }
        }
      };

      const onAbort = () => {
        killProcess();
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        if (code !== 0) {
          reject(new Error(`Command exited with code ${code}: ${stderr}`));
        } else {
          try {
            const result = stdout ? JSON.parse(stdout) : { result: null };
            resolve(result);
          } catch (e) {
            reject(new Error(`Invalid JSON output: ${stdout}`));
          }
        }
      });

      proc.stdin.write(JSON.stringify(ctx) + '\n');
      proc.stdin.end();
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

    const result = await this.mcpPool.call(
      route.invoke.server,
      ctx.toolName,
      ctx.args
    );

    return { result };
  }

  protected async loadModule(modulePath: string): Promise<any> {
    return import(modulePath);
  }

  protected spawnProcess(command: string, args: string[], options: any) {
    return spawn(command, args, options);
  }

  private createTimeout(
    seconds: number,
    options: {
      signal?: AbortSignal;
      onTimeout?: () => void;
    } = {}
  ): Promise<never> {
    return new Promise((_, reject) => {
      if (options.signal?.aborted) {
        return;
      }

      const timeoutId = setTimeout(() => {
        options.onTimeout?.();
        reject(new Error(`Tool execution timeout after ${seconds}s`));
      }, seconds * 1000);

      if (options.signal) {
        const onAbort = () => {
          clearTimeout(timeoutId);
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async close(): Promise<void> {
    // Cleanup if needed
  }
}
