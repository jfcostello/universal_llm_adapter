import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { glob } from 'glob';
import { loadJsonFile } from './config.js';
import { parseMCPManifest } from '../mcp/mcp-manifest.js';
import {
  ProviderManifest,
  UnifiedTool,
  MCPServerConfig,
  VectorStoreConfig,
  ProcessRouteManifest,
  ICompatModule
} from './types.js';
import { ManifestError } from './errors.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(moduleDir, '..');

export class PluginRegistry {
  private rootPath: string;
  private providers = new Map<string, ProviderManifest>();
  private tools = new Map<string, UnifiedTool>();
  private mcpServers = new Map<string, MCPServerConfig>();
  private vectorStores = new Map<string, VectorStoreConfig>();
  private processRoutes: ProcessRouteManifest[] = [];
  private compatModules = new Map<string, ICompatModule>();

  // Lazy loading flags
  private providersLoaded = false;
  private toolsLoaded = false;
  private mcpServersLoaded = false;
  private vectorStoresLoaded = false;
  private processRoutesLoaded = false;
  private compatModulesLoaded = false;

  constructor(rootPath: string) {
    this.rootPath = path.isAbsolute(rootPath)
      ? rootPath
      : path.resolve(process.cwd(), rootPath);

    if (!fs.existsSync(this.rootPath)) {
      throw new ManifestError(`Plugin directory '${this.rootPath}' does not exist`);
    }
  }

  async loadAll(): Promise<void> {
    // Deprecated: kept for backward compatibility but does nothing
    // All loading is now lazy and on-demand
  }

  private async loadProviders(): Promise<void> {
    if (this.providersLoaded) return;

    const files = glob.sync('providers/*.json', { cwd: this.rootPath });
    for (const file of files) {
      try {
        const manifest = loadJsonFile(path.join(this.rootPath, file)) as ProviderManifest;
        this.providers.set(manifest.id, manifest);
      } catch (error: any) {
        console.warn(`Skipping provider manifest ${file}: ${error.message}`);
      }
    }

    this.providersLoaded = true;
  }

  private async loadTools(): Promise<void> {
    if (this.toolsLoaded) return;

    const files = glob.sync('tools/*.json', { cwd: this.rootPath });
    for (const file of files) {
      try {
        const tool = loadJsonFile(path.join(this.rootPath, file)) as UnifiedTool;
        this.tools.set(tool.name, tool);
      } catch (error: any) {
        console.warn(`Skipping tool manifest ${file}: ${error.message}`);
      }
    }

    this.toolsLoaded = true;
  }

  private async loadMCPServers(): Promise<void> {
    if (this.mcpServersLoaded) return;

    const files = glob.sync('mcp/*.json', { cwd: this.rootPath });
    for (const file of files) {
      try {
        const manifestPath = path.join(this.rootPath, file);
        const manifest = loadJsonFile(manifestPath);
        const servers = parseMCPManifest(manifest, file);
        for (const server of servers) {
          this.mcpServers.set(server.id, server);
        }
      } catch (error: any) {
        console.warn(`Skipping MCP server manifest ${file}: ${error.message}`);
      }
    }

    this.mcpServersLoaded = true;
  }

  private async loadVectorStores(): Promise<void> {
    if (this.vectorStoresLoaded) return;

    const files = glob.sync('vector/*.json', { cwd: this.rootPath });
    for (const file of files) {
      try {
        const store = loadJsonFile(path.join(this.rootPath, file)) as VectorStoreConfig;
        this.vectorStores.set(store.id, store);
      } catch (error: any) {
        console.warn(`Skipping vector store manifest ${file}: ${error.message}`);
      }
    }

    this.vectorStoresLoaded = true;
  }

  private async loadProcessRoutes(): Promise<void> {
    if (this.processRoutesLoaded) return;

    const files = glob.sync('processes/*.json', { cwd: this.rootPath });
    for (const file of files) {
      try {
        const route = loadJsonFile(path.join(this.rootPath, file)) as ProcessRouteManifest;
        this.processRoutes.push(route);
      } catch (error: any) {
        console.warn(`Skipping process route manifest ${file}: ${error.message}`);
      }
    }

    this.processRoutesLoaded = true;
  }

  private async loadCompatModules(): Promise<void> {
    if (this.compatModulesLoaded) return;

    const compatCandidates = [
      path.resolve(distRoot, 'plugins', 'compat'),
      path.join(this.rootPath, 'compat'),
      path.resolve(process.cwd(), 'plugins', 'compat'),
    ];
    const visited = new Set<string>();

    for (const compatDir of compatCandidates) {
      if (!fs.existsSync(compatDir) || visited.has(compatDir)) {
        continue;
      }
      visited.add(compatDir);

      const files = fs
        .readdirSync(compatDir)
        .filter(f => {
          // Load compiled JS files
          if (f.endsWith('.js')) return true;
          // When scanning source during dev, include .ts but never .d.ts declarations
          if (compatDir.includes(path.join('plugins', 'compat')) && f.endsWith('.ts') && !f.endsWith('.d.ts')) {
            return true;
          }
          return false;
        });

      for (const file of files) {
        const moduleName = path.basename(file, path.extname(file));
        const modulePath = path.join(compatDir, file);

        // Prefer compiled JS modules; fall back to source when running in watch/dev mode.
        if (file.endsWith('.ts') && fs.existsSync(path.join(compatDir, `${moduleName}.js`))) {
          continue;
        }

        if (this.compatModules.has(moduleName)) {
          continue;
        }

        try {
          const imported = await import(pathToFileURL(modulePath).href);
          const CompatClass = imported.default || imported[Object.keys(imported)[0]];
          this.compatModules.set(moduleName, new CompatClass());
        } catch (error: any) {
          console.warn(`Failed to load compat module ${moduleName}: ${error.message}`);
        }
      }
    }

    this.compatModulesLoaded = true;
  }

  async getProvider(id: string): Promise<ProviderManifest> {
    await this.loadProviders();
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ManifestError(`Unknown provider '${id}'`);
    }
    return provider;
  }

  async getTool(name: string): Promise<UnifiedTool> {
    await this.loadTools();
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ManifestError(`Unknown tool '${name}'`);
    }
    return tool;
  }

  async getTools(names: string[]): Promise<UnifiedTool[]> {
    await this.loadTools();
    return names.map(name => {
      const tool = this.tools.get(name);
      if (!tool) {
        throw new ManifestError(`Unknown tool '${name}'`);
      }
      return tool;
    });
  }

  async getMCPServer(id: string): Promise<MCPServerConfig> {
    await this.loadMCPServers();
    const server = this.mcpServers.get(id);
    if (!server) {
      throw new ManifestError(`Unknown MCP server '${id}'`);
    }
    return server;
  }

  async getMCPServers(serverIds?: string[]): Promise<MCPServerConfig[]> {
    // Only load if specific servers requested
    if (!serverIds || serverIds.length === 0) {
      return [];
    }

    await this.loadMCPServers();

    return serverIds.map(id => {
      const server = this.mcpServers.get(id);
      if (!server) {
        throw new ManifestError(`Unknown MCP server '${id}'`);
      }
      return server;
    });
  }

  async getVectorStore(id: string): Promise<VectorStoreConfig> {
    await this.loadVectorStores();
    const store = this.vectorStores.get(id);
    if (!store) {
      throw new ManifestError(`Unknown vector store '${id}'`);
    }
    return store;
  }

  async getProcessRoutes(): Promise<ProcessRouteManifest[]> {
    await this.loadProcessRoutes();
    return this.processRoutes;
  }

  async getCompatModule(compat: string): Promise<ICompatModule> {
    await this.loadCompatModules();
    const module = this.compatModules.get(compat);
    if (!module) {
      throw new ManifestError(`No compat module found for '${compat}'`);
    }
    return module;
  }
}
