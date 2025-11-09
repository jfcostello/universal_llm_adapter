import { spawn, ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MCPServerConfig, UnifiedTool, JsonObject } from '../core/types.js';
import { MCPConnectionError } from '../core/errors.js';
import { getLogger } from '../core/logging.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json for client info
let packageInfo = { name: 'llm-adapter', version: '1.0.0' };
try {
  const packagePath = join(__dirname, '..', 'package.json');
  const packageData = JSON.parse(readFileSync(packagePath, 'utf-8'));
  packageInfo = {
    name: packageData.name || packageInfo.name,
    version: packageData.version || packageInfo.version
  };
} catch (error) {
  // Fallback to defaults if package.json is not readable
}

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface PendingRequest {
  resolve: Function;
  reject: Function;
  timer?: NodeJS.Timeout;
}

export class JSONRPCSession extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private buffer = '';

  constructor(
    private input: Readable,
    private output: Writable
  ) {
    super();
    this.setupStreams();
  }

  private setupStreams(): void {
    this.input.on('data', (chunk) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const message = JSON.parse(line);
        
        if (message.id && this.pending.has(message.id)) {
          const entry = this.pending.get(message.id)!;
          const { resolve, reject } = entry;
          this.pending.delete(message.id);
          
          if (entry.timer) {
            clearTimeout(entry.timer);
          }

          if (message.error) {
            reject(new Error(message.error.message));
          } else {
            resolve(message.result);
          }
        } else if (message.method) {
          // Notification or request from server
          this.emit('notification', message);
        }
      } catch (error) {
        // Invalid JSON, skip
      }
    }
  }

  async request(method: string, params?: any, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject };
      this.pending.set(id, entry);
      
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);
      entry.timer = timeout;

      this.output.write(JSON.stringify(request) + '\n', (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
}

export class MCPConnection {
  private process?: ChildProcess;
  private session?: JSONRPCSession;
  private toolNameMap = new Map<string, string>();
  private logger = getLogger();
  private requestTimeoutMs: number;
  private serverCapabilities?: JsonObject;
  private serverInfo?: JsonObject;

  constructor(private config: MCPServerConfig) {
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
  }

  async connect(): Promise<void> {
    if (this.session) return;

    if (!this.config.command) {
      throw new MCPConnectionError(`MCP server '${this.config.id}' missing command`);
    }

    const env = { ...process.env, ...(this.config.env || {}) };
    
    this.process = spawn(this.config.command, this.config.args || [], {
      env,
      stdio: ['pipe', 'pipe', 'inherit']
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new MCPConnectionError(`Failed to spawn MCP server '${this.config.id}'`);
    }

    this.session = new JSONRPCSession(this.process.stdout, this.process.stdin);

    // Initialize with MCP protocol 2025-03-26 spec
    const initializeResult = await this.session.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: this.config.capabilities ?? {},
      clientInfo: {
        name: packageInfo.name,
        version: packageInfo.version
      }
    }, this.requestTimeoutMs);

    this.serverCapabilities = initializeResult?.capabilities;
    this.serverInfo = initializeResult?.serverInfo;
  }

  async listTools(): Promise<UnifiedTool[]> {
    if (!this.session) {
      await this.connect();
    }

    const tools: UnifiedTool[] = [];
    this.toolNameMap.clear();
    
    let cursor: string | undefined;
    
    do {
      const result = await this.session!.request('tools/list', { cursor }, this.requestTimeoutMs);
      
      for (const tool of result.tools || []) {
        const originalName = tool.name;
        const prefixedName = originalName.startsWith(`${this.config.id}.`)
          ? originalName
          : `${this.config.id}.${originalName}`;
        
        this.toolNameMap.set(prefixedName, originalName);
        
        tools.push({
          name: prefixedName,
          description: tool.description,
          parametersJsonSchema: tool.inputSchema || tool.input_schema || {
            type: 'object',
            properties: {}
          }
        });
      }
      
      cursor = result.nextCursor;
    } while (cursor);

    return tools;
  }

  async callTool(name: string, args: any): Promise<any> {
    if (!this.session) {
      await this.connect();
    }

    // Map prefixed name back to original
    let callName = this.toolNameMap.get(name) || name;
    
    // Strip server prefix if present
    if (callName.startsWith(`${this.config.id}.`)) {
      callName = callName.slice(this.config.id.length + 1);
    }

    const result = await this.session!.request('tools/call', {
      name: callName,
      arguments: args || {}
    }, this.requestTimeoutMs);

    if (result.content) {
      return result.content;
    }

    return result;
  }

  async callToolStream(name: string, args: any): Promise<AsyncGenerator<any>> {
    if (!this.session) {
      await this.connect();
    }

    const response = await this.session!.request('tools/call_stream', {
      name,
      arguments: args || {}
    }, this.requestTimeoutMs);

    const chunks: any[] = response?.chunks ?? [];

    async function* generator() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    return generator();
  }

  async close(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }
    this.session = undefined;
    this.toolNameMap.clear();
  }

  getCapabilities(): JsonObject | undefined {
    return this.serverCapabilities;
  }

  getServerInfo(): JsonObject | undefined {
    return this.serverInfo;
  }
}

export class MCPClientPool {
  private connections = new Map<string, MCPConnection>();
  private logger = getLogger();

  constructor(private servers: MCPServerConfig[]) {}

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
    if (!connection) {
      return;
    }

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
      
      const connection = new MCPConnection(server);
      this.connections.set(serverId, connection);
    }
    
    return this.connections.get(serverId)!;
  }

  async close(): Promise<void> {
    // Close in reverse order
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
