import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { PluginRegistry } from '@/core/registry.ts';
import { ManifestError } from '@/core/errors.ts';
import { withTempCwd } from '@tests/helpers/temp-files.ts';
import { copyFixturePlugins } from '@tests/helpers/plugins.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

describe('core/registry', () => {
  test('throws when plugin directory missing', () => {
    expect(() => new PluginRegistry('/does/not/exist')).toThrow(ManifestError);
  });

  test('loads manifests and compat modules from fixtures', async () => {
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';

    await withTempCwd('registry', async (dir) => {
      const pluginsDir = path.join(dir, 'plugins');
      copyFixturePlugins(pluginsDir);
      const altManifestPath = path.join(pluginsDir, 'mcp', 'alt-local.json');
      fs.writeFileSync(
        altManifestPath,
        JSON.stringify(
          {
            'alt-local': {
              command: 'node',
              args: ['./tests/fixtures/mcp/server.mjs'],
              env: {
                MCP_SERVER_NAME: 'alt-local'
              },
              autoStart: false,
              description: 'Alternate local MCP server'
            }
          },
          null,
          2
        ),
        'utf-8'
      );

      const registry = new PluginRegistry('plugins');
      await registry.loadAll();

      const provider = await registry.getProvider('test-openai');
      expect(provider.id).toBe('test-openai');

      const tool = await registry.getTool('echo.text');
      expect(tool.name).toBe('echo.text');
      const tools = await registry.getTools(['echo.text']);
      expect(tools).toHaveLength(1);

      const mcp = await registry.getMCPServer('local');
      expect(mcp.id).toBe('local');
      const mcpServers = await registry.getMCPServers(['local', 'alt-local']);
      expect(mcpServers.map(s => s.id)).toContain('local');

      const altMcp = await registry.getMCPServer('alt-local');
      expect(altMcp.autoStart).toBe(false);
      expect(altMcp.description).toBe('Alternate local MCP server');

      const vector = await registry.getVectorStore('memory');
      expect(vector.id).toBe('memory');

      const routes = await registry.getProcessRoutes();
      expect(routes.some(route => route.id === 'echo-module')).toBe(true);

      await expect(registry.getTool('missing.tool')).rejects.toThrow(ManifestError);
      await expect(registry.getProvider('missing')).rejects.toThrow(ManifestError);
      await expect(registry.getMCPServer('missing')).rejects.toThrow(ManifestError);
      await expect(registry.getVectorStore('missing')).rejects.toThrow(ManifestError);

      const compat = await registry.getCompatModule('openai');
      expect(typeof compat.buildPayload).toBe('function');
    });
  });

  test('skips invalid manifests but continues loading', async () => {
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';

    await withTempCwd('registry-invalid', async (dir) => {
      const pluginsDir = path.join(dir, 'plugins');
      copyFixturePlugins(pluginsDir);
      const invalidPath = path.join(pluginsDir, 'providers', 'invalid.json');
      fs.writeFileSync(invalidPath, '{"id": "broken"', 'utf-8');

      const toolInvalid = path.join(pluginsDir, 'tools', 'invalid.json');
      const mcpInvalid = path.join(pluginsDir, 'mcp', 'invalid.json');
      const vectorInvalid = path.join(pluginsDir, 'vector', 'invalid.json');
      const processInvalid = path.join(pluginsDir, 'processes', 'invalid.json');

      fs.writeFileSync(toolInvalid, '{"id":', 'utf-8');
      fs.writeFileSync(mcpInvalid, '{"id":', 'utf-8');
      fs.writeFileSync(vectorInvalid, '{"id":', 'utf-8');
      fs.writeFileSync(processInvalid, '{"id":', 'utf-8');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const registry = new PluginRegistry(pluginsDir);

      // Trigger lazy loading which will skip invalid files and warn
      await expect(registry.getTool('echo.text')).resolves.toBeDefined();
      await registry.getProvider('test-openai').catch(() => {});
      await registry.getMCPServers(['local']).catch(() => {});
      await registry.getVectorStore('memory').catch(() => {});
      await registry.getProcessRoutes();

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.length).toBeGreaterThan(1);
      warnSpy.mockRestore();
    });
  });

  test('loadCompatModules handles duplicates, ts fallbacks, and import failures', async () => {
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';

    await withTempCwd('registry-compat-load', async (dir) => {
      const pluginsDir = path.join(dir, 'plugins');
      copyFixturePlugins(pluginsDir);

      const compatRoot = path.join(ROOT_DIR, 'plugins', 'compat');
      const compatLocal = path.join(pluginsDir, 'compat');
      fs.mkdirSync(compatLocal, { recursive: true });

      const files = {
        js: path.join(compatRoot, 'registry-temp.js'),
        ts: path.join(compatRoot, 'registry-temp.ts'),
        broken: path.join(compatRoot, 'registry-broken.js'),
        named: path.join(compatRoot, 'registry-named.js'),
        duplicate: path.join(compatLocal, 'registry-temp.js'),
        dts: path.join(compatRoot, 'registry-dts.d.ts')
      };

      fs.writeFileSync(
        files.js,
        'export default class RegistryTemp { constructor() { this.kind = "js"; } }',
        'utf-8'
      );
      fs.writeFileSync(
        files.ts,
        'export default class RegistryTempTs { constructor() { throw new Error("ts should be skipped when js exists"); } }',
        'utf-8'
      );
      fs.writeFileSync(
        files.named,
        'export class RegistryNamed { constructor() { this.kind = "named"; } }',
        'utf-8'
      );
      fs.writeFileSync(files.broken, 'throw new Error("registry broken compat");', 'utf-8');
      // Create duplicate in second compat directory to test line 150
      fs.writeFileSync(
        files.duplicate,
        'export default class RegistryTempDuplicate { constructor() { this.kind = "duplicate"; } }',
        'utf-8'
      );
      // Create a declaration file that should be ignored by loader
      fs.writeFileSync(
        files.dts,
        'export declare const ignored: string;\n',
        'utf-8'
      );

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const previousCwd = process.cwd();

      try {
        process.chdir(ROOT_DIR);

        const registry = new PluginRegistry(pluginsDir);

        // Trigger lazy loading of compat modules
        await registry.getCompatModule('openai');
        await registry.getCompatModule('registry-temp');

        const compatKeys = Array.from((registry as any).compatModules.keys());
        expect(compatKeys).toEqual(expect.arrayContaining(['openai', 'registry-temp']));
        // .d.ts declarations must be ignored and not produce loader warnings
        expect(compatKeys).not.toContain('registry-dts');
        await expect(registry.getCompatModule('registry-broken')).rejects.toThrow(ManifestError);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('registry-broken'));
        // Ensure no warning was produced for the .d.ts file
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('registry-dts'))).toBe(false);
        const tempCompat = await registry.getCompatModule('registry-temp');
        // Should be 'js' from first directory, not 'duplicate' from second
        expect(tempCompat.kind).toBe('js');
        const namedCompat = await registry.getCompatModule('registry-named');
        expect(namedCompat.kind).toBe('named');
      } finally {
        process.chdir(previousCwd);
        warnSpy.mockRestore();
        for (const file of Object.values(files)) {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
        }
      }
    });
  });

  describe('embedding providers and compats', () => {
    test('loads embedding provider config from plugins/embeddings', async () => {
      await withTempCwd('registry-embeddings', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        // Create embeddings directory and config
        const embeddingsDir = path.join(pluginsDir, 'embeddings');
        fs.mkdirSync(embeddingsDir, { recursive: true });
        fs.writeFileSync(
          path.join(embeddingsDir, 'test-embed.json'),
          JSON.stringify({
            id: 'test-embed',
            kind: 'openrouter',
            endpoint: {
              urlTemplate: 'https://test.api/embeddings',
              headers: { 'Authorization': 'Bearer test' }
            },
            model: 'test-model',
            dimensions: 128
          }),
          'utf-8'
        );

        const registry = new PluginRegistry(pluginsDir);
        const config = await registry.getEmbeddingProvider('test-embed');

        expect(config.id).toBe('test-embed');
        expect(config.kind).toBe('openrouter');
        expect(config.dimensions).toBe(128);

        // Call again to trigger early return in loadEmbeddingProviders
        const config2 = await registry.getEmbeddingProvider('test-embed');
        expect(config2.id).toBe('test-embed');
      });
    });

    test('throws ManifestError for unknown embedding provider', async () => {
      await withTempCwd('registry-embed-missing', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const registry = new PluginRegistry(pluginsDir);
        await expect(registry.getEmbeddingProvider('nonexistent')).rejects.toThrow(ManifestError);
      });
    });

    test('loads embedding compat module from plugins/embedding-compat', async () => {
      await withTempCwd('registry-embed-compat', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        // Use actual compiled modules from the project
        const registry = new PluginRegistry(pluginsDir);

        // The openrouter embedding compat is loaded from the project's dist/plugins/embedding-compat
        const compat = await registry.getEmbeddingCompat('openrouter');

        expect(typeof compat.embed).toBe('function');
        expect(typeof compat.getDimensions).toBe('function');
      });
    });

    test('throws ManifestError for unknown embedding compat', async () => {
      await withTempCwd('registry-embed-compat-missing', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const registry = new PluginRegistry(pluginsDir);
        await expect(registry.getEmbeddingCompat('nonexistent')).rejects.toThrow(ManifestError);
      });
    });

    test('loads vector store compat module from plugins/vector-compat', async () => {
      await withTempCwd('registry-vector-compat', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        // Use actual compiled modules from the project
        const registry = new PluginRegistry(pluginsDir);

        // The memory vector compat is loaded from the project's dist/plugins/vector-compat
        const compat = await registry.getVectorStoreCompat('memory');

        expect(typeof compat.connect).toBe('function');
        expect(typeof compat.query).toBe('function');
        expect(typeof compat.upsert).toBe('function');
      });
    });

    test('vector store compat instances are isolated across managers (close does not leak)', async () => {
      await withTempCwd('registry-vector-compat-isolation', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const registry = new PluginRegistry(pluginsDir);

        const storeConfig = await registry.getVectorStore('memory');
        // Fixtures may use legacy `type`/`connection.kind` fields; normalize to `kind`.
        const kind =
          (storeConfig as any).kind ??
          (storeConfig as any).type ??
          (storeConfig as any).connection?.kind;
        expect(kind).toBe('memory');
        const normalizedStoreConfig = { ...(storeConfig as any), kind };

        const compatA = await registry.getVectorStoreCompat(kind);
        const compatB = await registry.getVectorStoreCompat(kind);

        await compatA.connect(normalizedStoreConfig);
        await compatB.connect(normalizedStoreConfig);

        await compatB.upsert('documents', [
          { id: 'doc1', vector: [0.1], payload: { text: 'hello' } }
        ]);

        const before = await compatB.query('documents', [0.1], 1, { includePayload: true });
        expect(before).toHaveLength(1);

        // Closing compatA must not break compatB (simulates another request closing its compat)
        await compatA.close();

        const after = await compatB.query('documents', [0.1], 1, { includePayload: true });
        expect(after).toHaveLength(1);

        await compatB.close();
      });
    });

    test('throws ManifestError for unknown vector store compat', async () => {
      await withTempCwd('registry-vector-compat-missing', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const registry = new PluginRegistry(pluginsDir);
        await expect(registry.getVectorStoreCompat('nonexistent')).rejects.toThrow(ManifestError);
      });
    });

    test('skips invalid embedding configs but continues loading', async () => {
      await withTempCwd('registry-embed-invalid', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const embeddingsDir = path.join(pluginsDir, 'embeddings');
        fs.mkdirSync(embeddingsDir, { recursive: true });
        fs.writeFileSync(
          path.join(embeddingsDir, 'invalid.json'),
          '{"id":',
          'utf-8'
        );
        fs.writeFileSync(
          path.join(embeddingsDir, 'valid.json'),
          JSON.stringify({ id: 'valid', kind: 'test', endpoint: {}, model: 'test' }),
          'utf-8'
        );

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const registry = new PluginRegistry(pluginsDir);
        const config = await registry.getEmbeddingProvider('valid');

        expect(config.id).toBe('valid');
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
      });
    });

    test('returns ManifestError for non-existent embedding compat module', async () => {
      await withTempCwd('registry-embed-compat-broken', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const registry = new PluginRegistry(pluginsDir);

        // Should be able to load existing compat
        const compat = await registry.getEmbeddingCompat('openrouter');
        expect(typeof compat.embed).toBe('function');

        // Should throw for non-existent compat
        await expect(registry.getEmbeddingCompat('non-existent-broken')).rejects.toThrow(ManifestError);
      });
    });

    test('returns ManifestError for non-existent vector store compat module', async () => {
      await withTempCwd('registry-vector-compat-broken', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const registry = new PluginRegistry(pluginsDir);

        // Should be able to load existing compat
        const compat = await registry.getVectorStoreCompat('memory');
        expect(typeof compat.query).toBe('function');

        // Should throw for non-existent compat
        await expect(registry.getVectorStoreCompat('non-existent-broken')).rejects.toThrow(ManifestError);
      });
    });

    test('loadEmbeddingCompats handles duplicates, ts fallbacks, and import failures', async () => {
      await withTempCwd('registry-embed-compat-load', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const compatRoot = path.join(ROOT_DIR, 'plugins', 'embedding-compat');
        const compatLocal = path.join(pluginsDir, 'embedding-compat');
        fs.mkdirSync(compatLocal, { recursive: true });

        const files = {
          js: path.join(compatRoot, 'embed-test-temp.js'),
          ts: path.join(compatRoot, 'embed-test-temp.ts'),
          broken: path.join(compatRoot, 'embed-test-broken.js'),
          duplicate: path.join(compatLocal, 'embed-test-temp.js'),
          dts: path.join(compatRoot, 'embed-test-dts.d.ts')
        };

        fs.writeFileSync(
          files.js,
          'export default class EmbedTestTemp { constructor() { this.kind = "js"; } async embed() { return { vectors: [[1]], model: "m", dimensions: 1 }; } getDimensions() { return 1; } }',
          'utf-8'
        );
        fs.writeFileSync(
          files.ts,
          'export default class EmbedTestTempTs { constructor() { throw new Error("ts should be skipped when js exists"); } }',
          'utf-8'
        );
        fs.writeFileSync(files.broken, 'throw new Error("embed broken compat");', 'utf-8');
        fs.writeFileSync(
          files.duplicate,
          'export default class EmbedTestTempDuplicate { constructor() { this.kind = "duplicate"; } }',
          'utf-8'
        );
        fs.writeFileSync(files.dts, 'export declare const ignored: string;\n', 'utf-8');
        // Named export test (no default export)
        const namedFile = path.join(compatRoot, 'embed-test-named.js');
        fs.writeFileSync(
          namedFile,
          'export class EmbedTestNamed { constructor() { this.kind = "named"; } async embed() { return { vectors: [[1]], model: "m", dimensions: 1 }; } getDimensions() { return 1; } }',
          'utf-8'
        );
        (files as any).named = namedFile;

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const previousCwd = process.cwd();

        try {
          process.chdir(ROOT_DIR);

          const registry = new PluginRegistry(pluginsDir);

          // Trigger lazy loading
          await registry.getEmbeddingCompat('openrouter');
          await registry.getEmbeddingCompat('embed-test-temp');

          const compatKeys = Array.from((registry as any).embeddingCompats.keys());
          expect(compatKeys).toEqual(expect.arrayContaining(['openrouter', 'embed-test-temp', 'embed-test-named']));
          expect(compatKeys).not.toContain('embed-test-dts');
          await expect(registry.getEmbeddingCompat('embed-test-broken')).rejects.toThrow(ManifestError);
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('embed-test-broken'));
          expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('embed-test-dts'))).toBe(false);
          const tempCompat = await registry.getEmbeddingCompat('embed-test-temp');
          expect(tempCompat.kind).toBe('js');
          // Test named export fallback
          const namedCompat = await registry.getEmbeddingCompat('embed-test-named');
          expect(namedCompat.kind).toBe('named');
        } finally {
          process.chdir(previousCwd);
          warnSpy.mockRestore();
          for (const file of Object.values(files)) {
            if (fs.existsSync(file)) {
              fs.unlinkSync(file);
            }
          }
        }
      });
    });

    test('loadVectorStoreCompats handles duplicates, ts fallbacks, and import failures', async () => {
      await withTempCwd('registry-vector-compat-load', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const compatRoot = path.join(ROOT_DIR, 'plugins', 'vector-compat');
        const compatLocal = path.join(pluginsDir, 'vector-compat');
        fs.mkdirSync(compatLocal, { recursive: true });

        const files = {
          js: path.join(compatRoot, 'vector-test-temp.js'),
          ts: path.join(compatRoot, 'vector-test-temp.ts'),
          broken: path.join(compatRoot, 'vector-test-broken.js'),
          notAConstructor: path.join(compatRoot, 'vector-test-object.js'),
          duplicate: path.join(compatLocal, 'vector-test-temp.js'),
          dts: path.join(compatRoot, 'vector-test-dts.d.ts')
        };

        fs.writeFileSync(
          files.js,
          'export default class VectorTestTemp { constructor() { this.kind = "js"; } async connect() {} async close() {} async query() { return []; } async upsert() {} async deleteByIds() {} async collectionExists() { return false; } }',
          'utf-8'
        );
        fs.writeFileSync(
          files.ts,
          'export default class VectorTestTempTs { constructor() { throw new Error("ts should be skipped when js exists"); } }',
          'utf-8'
        );
        fs.writeFileSync(files.broken, 'throw new Error("vector broken compat");', 'utf-8');
        fs.writeFileSync(files.notAConstructor, 'export default { kind: \"object\" };', 'utf-8');
        fs.writeFileSync(
          files.duplicate,
          'export default class VectorTestTempDuplicate { constructor() { this.kind = "duplicate"; } }',
          'utf-8'
        );
        fs.writeFileSync(files.dts, 'export declare const ignored: string;\n', 'utf-8');
        // Named export test (no default export)
        const namedFile = path.join(compatRoot, 'vector-test-named.js');
        fs.writeFileSync(
          namedFile,
          'export class VectorTestNamed { constructor() { this.kind = "named"; } async connect() {} async close() {} async query() { return []; } async upsert() {} async deleteByIds() {} async collectionExists() { return false; } }',
          'utf-8'
        );
        (files as any).named = namedFile;

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const previousCwd = process.cwd();

        try {
          process.chdir(ROOT_DIR);

          const registry = new PluginRegistry(pluginsDir);

          // Trigger lazy loading
          await registry.getVectorStoreCompat('memory');
          await registry.getVectorStoreCompat('vector-test-temp');

          const compatKeys = Array.from((registry as any).vectorStoreCompats.keys());
          expect(compatKeys).toEqual(expect.arrayContaining(['memory', 'vector-test-temp', 'vector-test-named']));
          expect(compatKeys).not.toContain('vector-test-dts');
          await expect(registry.getVectorStoreCompat('vector-test-object')).rejects.toThrow(ManifestError);
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('vector-test-object'));
          await expect(registry.getVectorStoreCompat('vector-test-broken')).rejects.toThrow(ManifestError);
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('vector-test-broken'));
          expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('vector-test-dts'))).toBe(false);
          const tempCompat = await registry.getVectorStoreCompat('vector-test-temp');
          expect(tempCompat.kind).toBe('js');
          // Test named export fallback
          const namedCompat = await registry.getVectorStoreCompat('vector-test-named');
          expect(namedCompat.kind).toBe('named');
        } finally {
          process.chdir(previousCwd);
          warnSpy.mockRestore();
          for (const file of Object.values(files)) {
            if (fs.existsSync(file)) {
              fs.unlinkSync(file);
            }
          }
        }
      });
    });
  });
});
