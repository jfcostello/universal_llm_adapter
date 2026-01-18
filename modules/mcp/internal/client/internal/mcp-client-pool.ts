import type { MCPServerConfig, UnifiedTool } from '../../../../../kernel/index.js';
import { getNoopLogger, MCPConnectionError } from '../../../../../kernel/index.js';
import type { AdapterLogger } from '../../../../../kernel/index.js';

import { MCPConnection } from './mcp-connection.js';

export class MCPClientPool {
  private connections = new Map<string, MCPConnection>();
  private logger: AdapterLogger;

  constructor(private servers: MCPServerConfig[], options?: { logger?: AdapterLogger }) {
    this.logger = options?.logger ?? getNoopLogger();
  }

  getServerIds(): string[] {
    return this.servers.map(s => s.id);
  }

  async listTools(serverId: string): Promise<UnifiedTool[]> {
    const connection = await this.getConnection(serverId);
    return connection.listTools();
  }

  async call(serverId: string, toolName: string, args: any): Promise<any> {
    const connection = await this.getConnection(serverId);
    return connection.callTool(toolName, args);
  }

  async callStream(serverId: string, toolName: string, args: any): Promise<AsyncGenerator<any>> {
    const connection = await this.getConnection(serverId);
    return connection.callToolStream(toolName, args);
  }

  async getCapabilities(serverId: string): Promise<any> {
    const connection = await this.getConnection(serverId);
    return connection.getCapabilities();
  }

  async getServerInfo(serverId: string): Promise<any> {
    const connection = await this.getConnection(serverId);
    return connection.getServerInfo();
  }

  async resetConnection(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;

    try {
      await connection.close();
    } catch (error) {
      this.logger.debug(`Failed to reset MCP connection ${serverId}`, { error });
    } finally {
      this.connections.delete(serverId);
    }
  }

  private async getConnection(serverId: string): Promise<MCPConnection> {
    if (!this.connections.has(serverId)) {
      const server = this.servers.find(s => s.id === serverId);
      if (!server) {
        throw new MCPConnectionError(`Unknown MCP server '${serverId}'`);
      }

      const connection = new MCPConnection(server, { logger: this.logger });
      this.connections.set(serverId, connection);
    }

    return this.connections.get(serverId)!;
  }

  async close(): Promise<void> {
    const entries = Array.from(this.connections.entries()).reverse();

    for (const [serverId, connection] of entries) {
      try {
        await connection.close();
      } catch (error) {
        this.logger.debug(`Failed to close MCP connection ${serverId}`, { error });
      }
    }

    this.connections.clear();
  }
}

