import { JsonObject, MCPServerConfig, UnifiedTool } from '../../kernel/index.js';
import { MCPConnectionError } from '../../kernel/index.js';
import { MCPClientPool } from './client.js';
import { getLogger } from '../../logging/index.js';

export class MCPManager {
  private pool: MCPClientPool;
  private toolCache = new Map<string, UnifiedTool[]>();
  private logger = getLogger();

  constructor(private servers: MCPServerConfig[]) {
    this.pool = new MCPClientPool(servers);
  }

  listEnabledServers(): string[] {
    return this.servers
      .filter(s => s.autoStart !== false)
      .map(s => s.id);
  }

  async listTools(serverId: string, refresh = false): Promise<UnifiedTool[]> {
    if (!refresh && this.toolCache.has(serverId)) {
      return [...this.toolCache.get(serverId)!];
    }

    try {
      const tools = await this.pool.listTools(serverId);
      this.toolCache.set(serverId, tools);
      return [...tools];
    } catch (error) {
      if (error instanceof MCPConnectionError) {
        this.toolCache.delete(serverId);
        this.logger.warning('MCP connection failed; attempting to reset and retry', {
          server: serverId,
          error: error.message
        });

        await this.pool.resetConnection(serverId);

        try {
          const retryTools = await this.pool.listTools(serverId);
          this.toolCache.set(serverId, retryTools);
          return [...retryTools];
        } catch (retryError: any) {
          this.logger.error('Retry after MCP connection reset failed', {
            server: serverId,
            error: retryError?.message ?? String(retryError)
          });
          throw retryError;
        }
      }

      throw error;
    }
  }

  async discoverTools(serverId: string): Promise<UnifiedTool[]> {
    return this.listTools(serverId, true);
  }

  async collectAllEnabledTools(): Promise<Record<string, UnifiedTool[]>> {
    const results: Record<string, UnifiedTool[]> = {};

    for (const serverId of this.listEnabledServers()) {
      try {
        results[serverId] = await this.listTools(serverId);
      } catch (error) {
        this.logger.error(`Failed to list tools for MCP server ${serverId}`, { error });
      }
    }

    return results;
  }

  async gatherTools(requestedServers?: string[]): Promise<[UnifiedTool[], string[]]> {
    const serverIds = requestedServers ?? [];

    if (serverIds.length === 0) {
      return [[], []];
    }

    const collected = new Map<string, UnifiedTool>();
    const activeServers: string[] = [];

    for (const serverId of serverIds) {
      try {
        const tools = await this.listTools(serverId);

        if (tools.length === 0) continue;

        activeServers.push(serverId);
        for (const tool of tools) {
          collected.set(tool.name, tool);
        }
      } catch (error: any) {
        this.logger.error('Failed to list MCP server tools', {
          server: serverId,
          error: error.message
        });
      }
    }

    return [Array.from(collected.values()), activeServers];
  }

  getPool(): MCPClientPool {
    return this.pool;
  }

  async call(serverId: string, toolName: string, args: any): Promise<any> {
    return this.pool.call(serverId, toolName, args);
  }

  async streamTool(serverId: string, toolName: string, args: any): Promise<AsyncGenerator<any>> {
    return this.pool.callStream(serverId, toolName, args);
  }

  async getCapabilities(serverId: string): Promise<JsonObject | undefined> {
    return this.pool.getCapabilities(serverId);
  }

  async getServerInfo(serverId: string): Promise<JsonObject | undefined> {
    return this.pool.getServerInfo(serverId);
  }

  async close(): Promise<void> {
    try {
      await this.pool.close();
    } finally {
      this.toolCache.clear();
    }
  }
}

