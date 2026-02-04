import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { ManifestError, PluginRegistry } from '@/kernel/index.ts';
import { withTempCwd, writeJson } from '@tests/helpers/temp-files.ts';

function writeCjsClass(root: string, area: string, moduleName: string, marker: string): void {
  const filePath = path.join(root, area, moduleName, 'index.js');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `module.exports = class Compat { constructor() { this.__marker = ${JSON.stringify(marker)}; } }`,
    'utf-8'
  );
}

describe('core/registry (multi-root)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('loads each manifest area in multi-root mode (non-strict), supports overrides, and records manifest sources', async () => {
    await withTempCwd('registry-multi-root-areas', async (cwd) => {
      const rootA = path.join(cwd, 'pack-a');
      const rootB = path.join(cwd, 'pack-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });
      const rootBReal = fs.realpathSync(rootB);

      // providers
      writeJson(path.join(rootA, 'providers', 'dup.json'), { id: 'dup', compat: 'foo', marker: 'A', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });
      writeJson(path.join(rootB, 'providers', 'dup.json'), { id: 'dup', compat: 'foo', marker: 'B', endpoint: { urlTemplate: 'http://b', method: 'POST', headers: {} } });
      writeJson(path.join(rootA, 'providers', 'invalid.json'), { compat: 'foo' });
      fs.writeFileSync(path.join(rootA, 'providers', 'malformed.json'), '{', 'utf-8');

      // realtime providers
      writeJson(path.join(rootA, 'realtime-providers', 'dup.json'), { id: 'rt', compat: 'rt-compat', endpoint: { urlTemplate: 'ws://a', headers: {} } });
      writeJson(path.join(rootB, 'realtime-providers', 'dup.json'), { id: 'rt', compat: 'rt-compat', marker: 'B', endpoint: { urlTemplate: 'ws://b', headers: {} } });
      writeJson(path.join(rootA, 'realtime-providers', 'invalid.json'), { compat: 'rt-compat', endpoint: { urlTemplate: 'ws://x', headers: {} } });
      fs.writeFileSync(path.join(rootA, 'realtime-providers', 'malformed.json'), '{', 'utf-8');

      // tools
      writeJson(path.join(rootA, 'tools', 'dup.json'), { name: 'tool.x', description: 'A', parametersJsonSchema: { type: 'object', properties: {}, required: [] } });
      writeJson(path.join(rootB, 'tools', 'dup.json'), { name: 'tool.x', description: 'B', parametersJsonSchema: { type: 'object', properties: {}, required: [] } });
      writeJson(path.join(rootA, 'tools', 'invalid.json'), { description: 'missing name', parametersJsonSchema: { type: 'object' } });
      fs.writeFileSync(path.join(rootA, 'tools', 'malformed.json'), '{', 'utf-8');

      // MCP
      writeJson(path.join(rootA, 'mcp', 'servers.json'), { mcpServers: { local: { command: 'node', args: [], env: {}, autoStart: false } } });
      writeJson(path.join(rootB, 'mcp', 'servers.json'), { mcpServers: { local: { command: 'node', args: [], env: {}, autoStart: true } } });
      // Empty id should be skipped in non-strict mode (parse succeeds, registry layer enforces id presence)
      writeJson(path.join(rootA, 'mcp', 'invalid.json'), { mcpServers: { '': { command: 'node' } } });
      fs.writeFileSync(path.join(rootA, 'mcp', 'malformed.json'), '{', 'utf-8');

      // vector stores
      writeJson(path.join(rootA, 'vector', 'dup.json'), { id: 'store', kind: 'memory', marker: 'A', connection: {} });
      writeJson(path.join(rootB, 'vector', 'dup.json'), { id: 'store', kind: 'memory', marker: 'B', connection: {} });
      writeJson(path.join(rootA, 'vector', 'invalid.json'), { kind: 'memory', connection: {} });
      fs.writeFileSync(path.join(rootA, 'vector', 'malformed.json'), '{', 'utf-8');

      // processes
      writeJson(path.join(rootA, 'processes', 'dup.json'), { id: 'route', marker: 'A', match: { type: 'exact', pattern: 'x' }, invoke: { kind: 'module', module: './noop.mjs', function: 'handle' } });
      writeJson(path.join(rootB, 'processes', 'dup.json'), { id: 'route', marker: 'B', match: { type: 'exact', pattern: 'x' }, invoke: { kind: 'module', module: './noop.mjs', function: 'handle' } });
      writeJson(path.join(rootA, 'processes', 'invalid.json'), { match: { type: 'exact', pattern: 'x' }, invoke: { kind: 'module', module: './noop.mjs', function: 'handle' } });
      fs.writeFileSync(path.join(rootA, 'processes', 'malformed.json'), '{', 'utf-8');

      // embeddings
      writeJson(path.join(rootA, 'embeddings', 'dup.json'), { id: 'embed', kind: 'e-compat', marker: 'A', endpoint: { urlTemplate: 'http://a', headers: {} }, model: 'm' });
      writeJson(path.join(rootB, 'embeddings', 'dup.json'), { id: 'embed', kind: 'e-compat', marker: 'B', endpoint: { urlTemplate: 'http://b', headers: {} }, model: 'm' });
      writeJson(path.join(rootA, 'embeddings', 'invalid.json'), { kind: 'e-compat', endpoint: { urlTemplate: 'http://x', headers: {} }, model: 'm' });
      fs.writeFileSync(path.join(rootA, 'embeddings', 'malformed.json'), '{', 'utf-8');

      // observability providers
      writeJson(path.join(rootA, 'observability-providers', 'dup.json'), { id: 'obs', compat: 'obs-compat', marker: 'A', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });
      writeJson(path.join(rootB, 'observability-providers', 'dup.json'), { id: 'obs', compat: 'obs-compat', marker: 'B', endpoint: { urlTemplate: 'http://b', method: 'POST', headers: {} } });
      writeJson(path.join(rootA, 'observability-providers', 'invalid.json'), { compat: 'obs-compat', endpoint: { urlTemplate: 'http://x', method: 'POST', headers: {} } });
      fs.writeFileSync(path.join(rootA, 'observability-providers', 'malformed.json'), '{', 'utf-8');

      // signals providers
      writeJson(path.join(rootA, 'signals-providers', 'dup.json'), { id: 'sig', compat: 'sig-compat', marker: 'A', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });
      writeJson(path.join(rootB, 'signals-providers', 'dup.json'), { id: 'sig', compat: 'sig-compat', marker: 'B', endpoint: { urlTemplate: 'http://b', method: 'POST', headers: {} } });
      writeJson(path.join(rootA, 'signals-providers', 'invalid.json'), { compat: 'sig-compat', endpoint: { urlTemplate: 'http://x', method: 'POST', headers: {} } });
      fs.writeFileSync(path.join(rootA, 'signals-providers', 'malformed.json'), '{', 'utf-8');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const registry = new PluginRegistry({
          pluginsPath: './plugins',
          lookup: {
            warnOnOverride: true,
            builtinManifests: false,
            builtinCode: false,
            local: false,
            externalRoots: [rootA, rootB]
          }
        });

        await registry.loadAll(); // no-op but should be safe

        expect((await registry.getProvider('dup') as any).marker).toBe('B');
        expect(registry.getManifestSource('providers', 'dup')?.root).toBe(rootBReal);

        expect((await registry.getRealtimeProvider('rt') as any).marker).toBe('B');
        expect(registry.getManifestSource('realtime-providers', 'rt')?.root).toBe(rootBReal);

        expect((await registry.getTool('tool.x') as any).description).toBe('B');
        expect(registry.getManifestSource('tools', 'tool.x')?.root).toBe(rootBReal);

        expect((await registry.getMCPServer('local') as any).autoStart).toBe(true);
        expect(registry.getManifestSource('mcp', 'local')?.root).toBe(rootBReal);

        expect((await registry.getVectorStore('store') as any).marker).toBe('B');
        expect(registry.getManifestSource('vector', 'store')?.root).toBe(rootBReal);

        expect((await registry.getEmbeddingProvider('embed') as any).marker).toBe('B');
        expect(registry.getManifestSource('embeddings', 'embed')?.root).toBe(rootBReal);

        expect((await registry.getObservabilityProvider('obs') as any).marker).toBe('B');
        expect(registry.getManifestSource('observability-providers', 'obs')?.root).toBe(rootBReal);

        expect((await registry.getSignalsProvider('sig') as any).marker).toBe('B');
        expect(registry.getManifestSource('signals-providers', 'sig')?.root).toBe(rootBReal);

        const processRoutes = await registry.getProcessRoutes();
        expect((processRoutes.find(r => r.id === 'route') as any)?.marker).toBe('B');
        expect(registry.getManifestSource('processes', 'route')?.root).toBe(rootBReal);

        expect(warnSpy.mock.calls.some(([msg]) => msg === 'plugin_registry.override')).toBe(true);
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('Skipping'))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('validateAll uses strict multi-root loading and validates referenced plugin code (with code override warnings)', async () => {
    await withTempCwd('registry-multi-root-validateAll', async (cwd) => {
      const rootA = path.join(cwd, 'pack-a');
      const rootB = path.join(cwd, 'pack-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      // Manifests (duplicates across roots ensure override paths are exercised).
      writeJson(path.join(rootA, 'providers', 'p.json'), { id: 'p', compat: 'foo', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });
      writeJson(path.join(rootB, 'providers', 'p.json'), { id: 'p', compat: 'foo', endpoint: { urlTemplate: 'http://b', method: 'POST', headers: {} } });

      writeJson(path.join(rootA, 'realtime-providers', 'rt.json'), { id: 'rt', compat: 'rt-compat', endpoint: { urlTemplate: 'ws://a', headers: {} } });
      writeJson(path.join(rootB, 'realtime-providers', 'rt.json'), { id: 'rt', compat: 'rt-compat', endpoint: { urlTemplate: 'ws://b', headers: {} } });

      writeJson(path.join(rootA, 'tools', 't.json'), { name: 'tool.x', description: 'A', parametersJsonSchema: { type: 'object', properties: {}, required: [] } });
      writeJson(path.join(rootB, 'tools', 't.json'), { name: 'tool.x', description: 'B', parametersJsonSchema: { type: 'object', properties: {}, required: [] } });

      writeJson(path.join(rootA, 'mcp', 'servers.json'), { mcpServers: { local: { command: 'node', args: [], env: {}, autoStart: false } } });
      writeJson(path.join(rootB, 'mcp', 'servers.json'), { mcpServers: { local: { command: 'node', args: [], env: {}, autoStart: true } } });

      writeJson(path.join(rootA, 'vector', 'v.json'), { id: 'store', kind: 'v-compat', connection: {} });
      writeJson(path.join(rootB, 'vector', 'v.json'), { id: 'store', kind: 'v-compat', connection: {} });

      writeJson(path.join(rootA, 'processes', 'p.json'), { id: 'route', match: { type: 'exact', pattern: 'x' }, invoke: { kind: 'module', module: './noop.mjs', function: 'handle' } });
      writeJson(path.join(rootB, 'processes', 'p.json'), { id: 'route', match: { type: 'exact', pattern: 'x' }, invoke: { kind: 'module', module: './noop.mjs', function: 'handle' } });

      writeJson(path.join(rootA, 'embeddings', 'e.json'), { id: 'embed', kind: 'e-compat', endpoint: { urlTemplate: 'http://a', headers: {} }, model: 'm' });
      writeJson(path.join(rootB, 'embeddings', 'e.json'), { id: 'embed', kind: 'e-compat', endpoint: { urlTemplate: 'http://b', headers: {} }, model: 'm' });

      writeJson(path.join(rootA, 'observability-providers', 'o.json'), { id: 'obs', compat: 'obs-compat', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });
      writeJson(path.join(rootB, 'observability-providers', 'o.json'), { id: 'obs', compat: 'obs-compat', endpoint: { urlTemplate: 'http://b', method: 'POST', headers: {} } });

      writeJson(path.join(rootA, 'signals-providers', 's.json'), { id: 'sig', compat: 'sig-compat', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });
      writeJson(path.join(rootB, 'signals-providers', 's.json'), { id: 'sig', compat: 'sig-compat', endpoint: { urlTemplate: 'http://b', method: 'POST', headers: {} } });

      // Referenced plugin code (duplicates across roots produce deterministic override warnings).
      writeCjsClass(rootA, 'compat', 'foo', 'A');
      writeCjsClass(rootB, 'compat', 'foo', 'B');
      writeCjsClass(rootA, 'realtime-compat', 'rt-compat', 'A');
      writeCjsClass(rootB, 'realtime-compat', 'rt-compat', 'B');
      writeCjsClass(rootA, 'vector-compat', 'v-compat', 'A');
      writeCjsClass(rootB, 'vector-compat', 'v-compat', 'B');
      writeCjsClass(rootA, 'embedding-compat', 'e-compat', 'A');
      writeCjsClass(rootB, 'embedding-compat', 'e-compat', 'B');
      writeCjsClass(rootA, 'observability-compat', 'obs-compat', 'A');
      writeCjsClass(rootB, 'observability-compat', 'obs-compat', 'B');
      writeCjsClass(rootA, 'signals-compat', 'sig-compat', 'A');
      writeCjsClass(rootB, 'signals-compat', 'sig-compat', 'B');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const registry = new PluginRegistry({
          pluginsPath: './plugins',
          lookup: {
            warnOnOverride: true,
            builtinManifests: false,
            builtinCode: false,
            local: false,
            externalRoots: [rootA, rootB]
          }
        });

        await expect(registry.validateAll()).resolves.toBeUndefined();
        // Call a second time to ensure early-return paths for both manifests and plugin code caches are exercised.
        await expect(registry.validateAll()).resolves.toBeUndefined();

        const signals = await registry.getSignalsProvider('sig');
        expect(signals.id).toBe('sig');

        const signalsCompat = await registry.getSignalsCompatForProvider('sig');
        expect((signalsCompat as any).__marker).toBe('B');

        const compat = await registry.getCompatModuleForProvider('p');
        expect((compat as any).__marker).toBe('B');

        const compatModules = (registry as any).compatModules as Map<string, any>;
        expect(compatModules.size).toBe(1);
        expect(Array.from(compatModules.keys())[0]).toContain('@@');

        expect(warnSpy.mock.calls.some(([msg]) => msg === 'plugin_registry.override')).toBe(true);
        expect(warnSpy.mock.calls.some(([msg]) => msg === 'plugin_registry.code_override')).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('emits code override warnings when resolving a compat module without preferredPackRoot', async () => {
    await withTempCwd('registry-multi-root-code-override-warning', async (cwd) => {
      const rootA = path.join(cwd, 'pack-a');
      const rootB = path.join(cwd, 'pack-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      writeCjsClass(rootA, 'compat', 'foo', 'A');
      writeCjsClass(rootB, 'compat', 'foo', 'B');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const registry = new PluginRegistry({
          pluginsPath: './plugins',
          lookup: {
            warnOnOverride: true,
            builtinManifests: false,
            builtinCode: false,
            local: false,
            externalRoots: [rootA, rootB]
          }
        });

        const compat = await registry.getCompatModule('foo');
        expect((compat as any).__marker).toBe('B');
        expect(warnSpy.mock.calls.some(([msg]) => msg === 'plugin_registry.code_override')).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('prefer-same-root binding: each provider type resolves code from its manifest pack root when available', async () => {
    await withTempCwd('registry-multi-root-prefer-same-root', async (cwd) => {
      const rootA = path.join(cwd, 'pack-a');
      const rootB = path.join(cwd, 'pack-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      writeJson(path.join(rootA, 'providers', 'p.json'), { id: 'p', compat: 'foo', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });
      writeJson(path.join(rootA, 'realtime-providers', 'rt.json'), { id: 'rt', compat: 'rt-compat', endpoint: { urlTemplate: 'ws://a', headers: {} } });
      writeJson(path.join(rootA, 'vector', 'v.json'), { id: 'store', kind: 'v-compat', connection: {} });
      writeJson(path.join(rootA, 'embeddings', 'e.json'), { id: 'embed', kind: 'e-compat', endpoint: { urlTemplate: 'http://a', headers: {} }, model: 'm' });
      writeJson(path.join(rootA, 'observability-providers', 'o.json'), { id: 'obs', compat: 'obs-compat', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });

      writeCjsClass(rootA, 'compat', 'foo', 'A');
      writeCjsClass(rootB, 'compat', 'foo', 'B');
      writeCjsClass(rootA, 'realtime-compat', 'rt-compat', 'A');
      writeCjsClass(rootB, 'realtime-compat', 'rt-compat', 'B');
      writeCjsClass(rootA, 'vector-compat', 'v-compat', 'A');
      writeCjsClass(rootB, 'vector-compat', 'v-compat', 'B');
      writeCjsClass(rootA, 'embedding-compat', 'e-compat', 'A');
      writeCjsClass(rootB, 'embedding-compat', 'e-compat', 'B');
      writeCjsClass(rootA, 'observability-compat', 'obs-compat', 'A');
      writeCjsClass(rootB, 'observability-compat', 'obs-compat', 'B');

      const registry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: true,
          builtinManifests: false,
          builtinCode: false,
          local: false,
          externalRoots: [rootA, rootB]
        }
      });

      expect((await registry.getCompatModuleForProvider('p') as any).__marker).toBe('A');
      expect((await registry.getRealtimeCompatForProvider('rt') as any).__marker).toBe('A');
      expect((await registry.getVectorStoreCompatForStore('store') as any).__marker).toBe('A');
      expect((await registry.getEmbeddingCompatForProvider('embed') as any).__marker).toBe('A');
      expect((await registry.getObservabilityCompatForProvider('obs') as any).__marker).toBe('A');

      await expect(registry.getCompatModuleForProvider('missing')).rejects.toThrow(ManifestError);
      await expect(registry.getRealtimeCompatForProvider('missing')).rejects.toThrow(ManifestError);
      await expect(registry.getVectorStoreCompatForStore('missing')).rejects.toThrow(ManifestError);
      await expect(registry.getEmbeddingCompatForProvider('missing')).rejects.toThrow(ManifestError);
      await expect(registry.getObservabilityCompatForProvider('missing')).rejects.toThrow(ManifestError);
    });
  });

  test('prefer-same-root binding: override scan tolerates missing code roots in other pack roots', async () => {
    await withTempCwd('registry-multi-root-prefer-same-root-missing-code-root', async (cwd) => {
      const rootA = path.join(cwd, 'pack-a');
      const rootB = path.join(cwd, 'pack-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      writeJson(path.join(rootA, 'providers', 'p.json'), { id: 'p', compat: 'foo', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });
      writeCjsClass(rootA, 'compat', 'foo', 'A');
      // rootB intentionally has no `compat/` directory.

      const registry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: true,
          builtinManifests: false,
          builtinCode: false,
          local: false,
          externalRoots: [rootA, rootB]
        }
      });

      expect((await registry.getCompatModuleForProvider('p') as any).__marker).toBe('A');
    });
  });

  test('multi-root: compat cache key is stable across provider-based and direct loads (same winner root)', async () => {
    await withTempCwd('registry-multi-root-compat-cache-key-stable', async (cwd) => {
      const rootA = path.join(cwd, 'pack-a');
      const rootB = path.join(cwd, 'pack-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      writeJson(path.join(rootA, 'providers', 'p.json'), { id: 'p', compat: 'foo', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });

      writeCjsClass(rootA, 'compat', 'foo', 'A');
      writeCjsClass(rootB, 'compat', 'foo', 'B');

      const registry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: false,
          builtinManifests: false,
          builtinCode: false,
          local: false,
          externalRoots: [rootB, rootA]
        }
      });

      expect((await registry.getCompatModuleForProvider('p') as any).__marker).toBe('A');
      expect((await registry.getCompatModule('foo') as any).__marker).toBe('A');

      const compatModules = (registry as any).compatModules as Map<string, any>;
      expect(compatModules.size).toBe(1);
    });
  });

  test('multi-root: compat cache key uses winner root when preferred root lacks the module', async () => {
    await withTempCwd('registry-multi-root-compat-cache-key-fallback', async (cwd) => {
      const rootA = path.join(cwd, 'pack-a');
      const rootB = path.join(cwd, 'pack-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      writeJson(path.join(rootA, 'providers', 'p.json'), { id: 'p', compat: 'foo', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });
      writeCjsClass(rootB, 'compat', 'foo', 'B');

      const registry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: false,
          builtinManifests: false,
          builtinCode: false,
          local: false,
          externalRoots: [rootA, rootB]
        }
      });

      expect((await registry.getCompatModuleForProvider('p') as any).__marker).toBe('B');
      expect((await registry.getCompatModule('foo') as any).__marker).toBe('B');

      const compatModules = (registry as any).compatModules as Map<string, any>;
      expect(compatModules.size).toBe(1);
    });
  });

  test('multi-root: prefer-same-root does not bypass code-source restrictions for preferred roots', async () => {
    await withTempCwd('registry-multi-root-preferred-root-gated', async (cwd) => {
      const externalPack = path.join(cwd, 'external-pack');
      fs.mkdirSync(externalPack, { recursive: true });

      // Provider manifest is in the external pack root.
      writeJson(path.join(externalPack, 'providers', 'p.json'), { id: 'p', compat: 'foo', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });

      // Compat exists in both the external pack (should be ignored) and the local plugins root (should be used).
      writeCjsClass(externalPack, 'compat', 'foo', 'EXTERNAL');
      writeCjsClass(path.join(cwd, 'plugins'), 'compat', 'foo', 'LOCAL');

      const registry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: false,
          builtinManifests: false,
          builtinCode: false,
          local: true,
          externalRoots: [],
          areas: {
            providers: { local: false, externalRoots: [externalPack] }
          }
        }
      });

      expect((await registry.getCompatModuleForProvider('p') as any).__marker).toBe('LOCAL');
    });
  });

  test('ignores missing roots in multi-root mode', async () => {
    await withTempCwd('registry-multi-root-missing-root', async (cwd) => {
      const existing = path.join(cwd, 'pack');
      fs.mkdirSync(existing, { recursive: true });
      writeJson(path.join(existing, 'providers', 'one.json'), { id: 'one', compat: 'foo', endpoint: { urlTemplate: 'http://x', method: 'POST', headers: {} } });

      const registry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: true,
          builtinManifests: false,
          builtinCode: false,
          local: false,
          externalRoots: [path.join(cwd, 'does-not-exist'), existing]
        }
      });

      await expect(registry.getProvider('one')).resolves.toBeDefined();
    });
  });

  test('warnOnOverride=false suppresses manifest and code override warnings', async () => {
    await withTempCwd('registry-multi-root-no-warn', async (cwd) => {
      const rootA = path.join(cwd, 'pack-a');
      const rootB = path.join(cwd, 'pack-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      writeJson(path.join(rootA, 'providers', 'dup.json'), { id: 'dup', compat: 'foo', endpoint: { urlTemplate: 'http://a', method: 'POST', headers: {} } });
      writeJson(path.join(rootB, 'providers', 'dup.json'), { id: 'dup', compat: 'foo', endpoint: { urlTemplate: 'http://b', method: 'POST', headers: {} } });

      writeCjsClass(rootA, 'compat', 'foo', 'A');
      writeCjsClass(rootB, 'compat', 'foo', 'B');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const registry = new PluginRegistry({
          pluginsPath: './plugins',
          lookup: {
            warnOnOverride: false,
            builtinManifests: false,
            builtinCode: false,
            local: false,
            externalRoots: [rootA, rootB]
          }
        });

        await expect(registry.getProvider('dup')).resolves.toBeDefined();
        await expect(registry.getCompatModule('foo')).resolves.toBeDefined();

        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('area-specific lookup overrides base config (local-only for providers)', async () => {
    await withTempCwd('registry-multi-root-area-override', async (cwd) => {
      const localPlugins = path.join(cwd, 'plugins');
      writeJson(path.join(localPlugins, 'providers', 'local.json'), { id: 'local-provider', compat: 'foo', endpoint: { urlTemplate: 'http://local', method: 'POST', headers: {} } });

      // Disable all base lookups, then re-enable local for providers only.
      const registry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: true,
          builtinManifests: false,
          builtinCode: false,
          local: false,
          externalRoots: [],
          areas: {
            providers: { local: true }
          }
        }
      });

      const provider = await registry.getProvider('local-provider');
      expect(provider.id).toBe('local-provider');
      expect(registry.getManifestSource('providers', 'local-provider')?.kind).toBe('local');
    });
  });

  test('dedupes externalRoots (base + per-area) while preserving order', async () => {
    await withTempCwd('registry-multi-root-dedupe-external-roots', async (cwd) => {
      const rootA = path.join(cwd, 'pack-a');
      const rootB = path.join(cwd, 'pack-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });
      const rootAReal = fs.realpathSync(rootA);
      const rootBReal = fs.realpathSync(rootB);

      const registry = new PluginRegistry({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: true,
          builtinManifests: false,
          builtinCode: false,
          local: false,
          externalRoots: [rootA, rootA, rootB, rootA],
          areas: {
            compat: { externalRoots: [rootB, rootB] }
          }
        }
      });

      const lookup = (registry as any).lookup as any;
      expect(lookup.base.externalRoots).toEqual([rootAReal, rootBReal]);
      expect(lookup.areas.compat.externalRoots).toEqual([rootBReal]);
    });
  });

  describe('validateAll strict id/name checks', () => {
    const cases: Array<{
      name: string;
      area: string;
      filePath: string;
      data: any;
    }> = [
      { name: 'providers', area: 'providers', filePath: 'providers/bad.json', data: { compat: 'foo', endpoint: { urlTemplate: 'http://x', method: 'POST', headers: {} } } },
      { name: 'realtime-providers', area: 'realtime-providers', filePath: 'realtime-providers/bad.json', data: { compat: 'rt-compat', endpoint: { urlTemplate: 'ws://x', headers: {} } } },
      { name: 'tools', area: 'tools', filePath: 'tools/bad.json', data: { description: 'missing name', parametersJsonSchema: { type: 'object', properties: {}, required: [] } } },
      { name: 'mcp', area: 'mcp', filePath: 'mcp/bad.json', data: { mcpServers: { '': { command: 'node' } } } },
      { name: 'vector', area: 'vector', filePath: 'vector/bad.json', data: { kind: 'memory', connection: {} } },
      { name: 'processes', area: 'processes', filePath: 'processes/bad.json', data: { match: { type: 'exact', pattern: 'x' }, invoke: { kind: 'module', module: './noop.mjs', function: 'handle' } } },
      { name: 'embeddings', area: 'embeddings', filePath: 'embeddings/bad.json', data: { kind: 'e-compat', endpoint: { urlTemplate: 'http://x', headers: {} }, model: 'm' } },
      { name: 'observability-providers', area: 'observability-providers', filePath: 'observability-providers/bad.json', data: { compat: 'obs-compat', endpoint: { urlTemplate: 'http://x', method: 'POST', headers: {} } } },
      { name: 'signals-providers', area: 'signals-providers', filePath: 'signals-providers/bad.json', data: { compat: 'sig-compat', endpoint: { urlTemplate: 'http://x', method: 'POST', headers: {} } } }
    ];

    test.each(cases)('throws on missing id/name in strict mode (%s)', async ({ name, area, filePath, data }) => {
      await withTempCwd(`registry-multi-root-strict-${name}`, async (cwd) => {
        const root = path.join(cwd, 'pack');
        fs.mkdirSync(root, { recursive: true });
        writeJson(path.join(root, filePath), data);

        const registry = new PluginRegistry({
          pluginsPath: './plugins',
          lookup: {
            warnOnOverride: true,
            builtinManifests: false,
            builtinCode: false,
            local: false,
            externalRoots: [],
            areas: {
              [area]: { externalRoots: [root] }
            }
          }
        });

        await expect(registry.validateAll()).rejects.toThrow(ManifestError);
      });
    });
  });
});
