import { spawn } from 'child_process';
import axios from 'axios';
import { minimatch } from 'minimatch';
import { ProcessRouteManifest, VectorContextConfig } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';
import { MCPClientPool } from '../../mcp/mcp-client.js';
import { AdapterLogger } from '../../core/logging.js';
import { getDefaults } from '../../core/defaults.js';
import { PluginRegistry } from '../../core/registry.js';

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
}

export class ToolCoordinator {
  private mcpServerIds: string[] = [];
  private vectorContext?: VectorContextConfig;
  private registry?: PluginRegistry;
  private vectorToolName: string = 'vector_search';

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
  }

  /**
   * Update vector context configuration.
   * Called when a new LLM call has different vector settings.
   */
  setVectorContext(config: VectorContextConfig | undefined, registry?: PluginRegistry): void {
    this.vectorContext = config;
    if (config) {
      this.vectorToolName = config.toolName ?? 'vector_search';
    }
    if (registry) {
      this.registry = registry;
    }
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

    const timeout = (route.timeoutMs || getDefaults().tools.timeoutMs) / 1000;

    try {
      const result = await Promise.race([
        this.invoke(route, ctx),
        this.createTimeout(timeout)
      ]);

      return result;
    } catch (error: any) {
      throw new ToolExecutionError(`Process route '${route.id}' failed: ${error.message}`);
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

    context.logger?.info('Invoking built-in vector_search handler', {
      toolName,
      callId,
      hasLocks: !!this.vectorContext.locks,
      lockedParams: Object.keys(this.vectorContext.locks ?? {})
    });

    // Lazy-load the handler to avoid circular dependencies
    const { executeVectorSearch, formatVectorSearchResults } = await import('./vector-search-handler.js');

    const result = await executeVectorSearch(
      {
        query: args.query,
        topK: args.topK,
        store: args.store
      },
      {
        vectorConfig: this.vectorContext,
        registry: this.registry,
        logger: context.logger
      }
    );

    // Format result for LLM consumption
    const formattedResult = formatVectorSearchResults(result);

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

  private async invoke(route: ProcessRouteManifest, ctx: ToolContext): Promise<any> {
    switch (route.invoke.kind) {
      case 'module':
        return this.invokeModule(route, ctx);
      case 'http':
        return this.invokeHttp(route, ctx);
      case 'command':
        return this.invokeCommand(route, ctx);
      case 'mcp':
        return this.invokeMcp(route, ctx);
      default:
        throw new ToolExecutionError(`Unsupported invoke kind '${route.invoke.kind}'`);
    }
  }

  private async invokeModule(route: ProcessRouteManifest, ctx: ToolContext): Promise<any> {
    if (!route.invoke.module) {
      throw new ToolExecutionError('Module route missing module field');
    }
    
    const modulePath = route.invoke.module.startsWith('.')
      ? `${process.cwd()}/${route.invoke.module}`
      : route.invoke.module;
    
    const module = await this.loadModule(modulePath);
    const fn = route.invoke.function || 'handle';
    const handler = module[fn] || module.default || module;
    
    const invocation = await handler(ctx);
    if (invocation && typeof invocation === 'object' && 'result' in invocation) {
      return invocation;
    }
    return { result: invocation };
  }

  private async invokeHttp(route: ProcessRouteManifest, ctx: ToolContext): Promise<any> {
    if (!route.invoke.url) {
      throw new ToolExecutionError('HTTP route missing url');
    }
    
    const response = await axios.request({
      method: route.invoke.method || 'POST',
      url: route.invoke.url,
      headers: route.invoke.headers || {},
      data: ctx
    });
    
    return response.data || { result: null };
  }

  private async invokeCommand(route: ProcessRouteManifest, ctx: ToolContext): Promise<any> {
    if (!route.invoke.command) {
      throw new ToolExecutionError('Command route missing command');
    }
    
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...(route.invoke.env || {}) };
      
      const proc = this.spawnProcess(route.invoke.command!, route.invoke.args || [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('close', (code) => {
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

  private async invokeMcp(route: ProcessRouteManifest, ctx: ToolContext): Promise<any> {
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

  private createTimeout(seconds: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool execution timeout after ${seconds}s`));
      }, seconds * 1000);
    });
  }

  async close(): Promise<void> {
    // Cleanup if needed
  }
}
