import { spawn } from 'child_process';
import axios from 'axios';
import { minimatch } from 'minimatch';
import { ProcessRouteManifest } from '../../core/types.js';
import { ToolExecutionError } from '../../core/errors.js';
import { MCPClientPool } from '../../mcp/mcp-client.js';
import { AdapterLogger } from '../../core/logging.js';

interface ToolContext {
  toolName: string;
  callId: string;
  args: any;
  provider: string;
  model: string;
  metadata?: any;
  callProgress?: any;
}

export class ToolCoordinator {
  private mcpServerIds: string[] = [];

  constructor(
    private routes: ProcessRouteManifest[],
    private mcpPool?: MCPClientPool
  ) {
    // Extract MCP server IDs from the pool
    if (mcpPool) {
      this.mcpServerIds = (mcpPool as any).servers?.map((s: any) => s.id) || [];
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
    
    const timeout = (route.timeoutMs || 120000) / 1000;
    
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
