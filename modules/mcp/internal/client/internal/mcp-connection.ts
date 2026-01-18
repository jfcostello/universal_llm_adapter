import { ChildProcess, spawn } from 'child_process';

import type {
  JsonObject,
  MCPServerConfig,
  UnifiedTool
} from '../../../../../kernel/index.js';
import {
  getDefaults,
  getNoopLogger,
  MCPConnectionError
} from '../../../../../kernel/index.js';
import type { AdapterLogger } from '../../../../../kernel/index.js';

import { PACKAGE_INFO } from './package-info.js';
import { JSONRPCSession } from './jsonrpc-session.js';

export class MCPConnection {
  private process?: ChildProcess;
  private session?: JSONRPCSession;
  private toolNameMap = new Map<string, string>();
  private logger: AdapterLogger;
  private requestTimeoutMs: number;
  private serverCapabilities?: JsonObject;
  private serverInfo?: JsonObject;

  constructor(private config: MCPServerConfig, options?: { logger?: AdapterLogger }) {
    this.requestTimeoutMs = config.requestTimeoutMs ?? getDefaults().timeouts.mcpRequest;
    this.logger = options?.logger ?? getNoopLogger();
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

    try {
      const initializeResult = await this.session.request(
        'initialize',
        {
          protocolVersion: '2025-03-26',
          capabilities: this.config.capabilities ?? {},
          clientInfo: {
            name: PACKAGE_INFO.name,
            version: PACKAGE_INFO.version
          }
        },
        this.requestTimeoutMs
      );

      this.serverCapabilities = initializeResult?.capabilities;
      this.serverInfo = initializeResult?.serverInfo;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async listTools(): Promise<UnifiedTool[]> {
    if (!this.session) await this.connect();

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
          parametersJsonSchema:
            tool.inputSchema ||
            tool.input_schema || {
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
    if (!this.session) await this.connect();

    let callName = this.toolNameMap.get(name) || name;
    if (callName.startsWith(`${this.config.id}.`)) {
      callName = callName.slice(this.config.id.length + 1);
    }

    const result = await this.session!.request(
      'tools/call',
      {
        name: callName,
        arguments: args || {}
      },
      this.requestTimeoutMs
    );

    if (result.content) return result.content;
    return result;
  }

  async callToolStream(name: string, args: any): Promise<AsyncGenerator<any>> {
    if (!this.session) await this.connect();

    const response = await this.session!.request(
      'tools/call_stream',
      {
        name,
        arguments: args || {}
      },
      this.requestTimeoutMs
    );

    const chunks: any[] = response?.chunks ?? [];

    async function* generator() {
      for (const chunk of chunks) yield chunk;
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
