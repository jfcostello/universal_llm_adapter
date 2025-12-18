import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { PluginRegistry } from '@/modules/kernel/index.ts';
import { ManifestError } from '@/modules/kernel/index.ts';
import { PACKAGE_ROOT } from '@/modules/kernel/internal/paths.ts';
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

      const compatA = await registry.getCompatModule('openai');
      const compatB = await registry.getCompatModule('openai');
      expect(compatA).not.toBe(compatB);
      expect(typeof compatA.buildPayload).toBe('function');
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

	      const dirRoot = path.join(compatRoot, 'registry-temp');

	      const files = {
	        js: path.join(compatRoot, 'registry-temp.js'),
	        ts: path.join(compatRoot, 'registry-temp.ts'),
	        dirIndexJs: path.join(dirRoot, 'index.js'),
	        broken: path.join(compatRoot, 'registry-broken.js'),
	        named: path.join(compatRoot, 'registry-named.js'),
	        duplicate: path.join(compatLocal, 'registry-temp.js'),
	        dts: path.join(compatRoot, 'registry-dts.d.ts')
	      };

	      fs.mkdirSync(dirRoot, { recursive: true });
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
	        files.dirIndexJs,
	        'export default class RegistryTempDir { constructor() { this.kind = "dir"; } }',
	        'utf-8'
	      );
      fs.writeFileSync(
        files.named,
        'export class RegistryNamed { constructor() { this.kind = "named"; } }',
        'utf-8'
      );
      fs.writeFileSync(files.broken, 'throw new Error("registry broken compat");', 'utf-8');
	      // Create duplicate in second compat directory; first directory should win.
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
	        // Directory-based modules should be preferred over legacy single-file modules.
	        expect(tempCompat.kind).toBe('dir');
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
	        if (fs.existsSync(dirRoot)) {
	          fs.rmSync(dirRoot, { recursive: true, force: true });
	        }
	      }
	    });
  });

  test('plugin code loader prefers dirs, supports .ts fallback, and errors on missing/non-constructors', async () => {
    const previousCwd = process.cwd();
    const compatRoot = path.join(ROOT_DIR, 'plugins', 'compat');
    const embedCompatRoot = path.join(ROOT_DIR, 'plugins', 'embedding-compat');

    const files = {
      compatTsOnly: path.join(compatRoot, 'registry-ts-only.ts'),
      compatObjectJs: path.join(compatRoot, 'registry-object.js'),
      embedObjectJs: path.join(embedCompatRoot, 'embed-object.js'),
    };

    try {
      process.chdir(PACKAGE_ROOT);

      fs.writeFileSync(
        files.compatTsOnly,
        'export default class RegistryTsOnly { constructor() { this.kind = \"ts-only\"; } }',
        'utf-8'
      );
      fs.writeFileSync(files.compatObjectJs, 'export default { kind: \"object\" };', 'utf-8');
      fs.writeFileSync(files.embedObjectJs, 'export default { kind: \"object\" };', 'utf-8');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const registry = new PluginRegistry('plugins');

      const tsOnly = await registry.getCompatModule('registry-ts-only');
      expect((tsOnly as any).kind).toBe('ts-only');

      await expect(registry.getCompatModule('definitely-missing')).rejects.toThrow(ManifestError);
      await expect(registry.getCompatModule('registry-object')).rejects.toThrow(ManifestError);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('registry-object'));

      await expect(registry.getEmbeddingCompat('embed-object')).rejects.toThrow(ManifestError);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('embed-object'));

      warnSpy.mockRestore();
    } finally {
      process.chdir(previousCwd);
      for (const file of Object.values(files)) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    }
  });

  describe('realtime compats', () => {
    test('loads realtime compat module from plugins/realtime-compat and enforces module name safety', async () => {
      await withTempCwd('registry-realtime-compat', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const previousCwd = process.cwd();
        const rtCompatRoot = path.join(ROOT_DIR, 'plugins', 'realtime-compat');
        const rtCompatLocal = path.join(pluginsDir, 'realtime-compat');
        fs.mkdirSync(rtCompatRoot, { recursive: true });
        fs.mkdirSync(rtCompatLocal, { recursive: true });

        const tempDir = path.join(rtCompatRoot, 'registry-rt-temp');
        const tempDirIndex = path.join(tempDir, 'index.js');
        const tempObject = path.join(rtCompatRoot, 'registry-rt-object.js');
        const localDuplicate = path.join(rtCompatLocal, 'registry-rt-temp.js');

        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(
          tempDirIndex,
          'export default class RegistryRtTempDir { constructor() { this.kind = \"dir\"; } }',
          'utf-8'
        );
        // Duplicate in local plugins dir; dist/plugins should win.
        fs.writeFileSync(
          localDuplicate,
          'export default class RegistryRtTempDuplicate { constructor() { this.kind = \"duplicate\"; } }',
          'utf-8'
        );
        fs.writeFileSync(tempObject, 'export default { kind: \"object\" };', 'utf-8');

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        try {
          process.chdir(ROOT_DIR);

          const registry = new PluginRegistry(pluginsDir);

          const compatA = await registry.getRealtimeCompat('registry-rt-temp');
          const compatB = await registry.getRealtimeCompat('registry-rt-temp');
          expect(compatA).not.toBe(compatB);
          expect((compatA as any).kind).toBe('dir');

          await expect(registry.getRealtimeCompat('definitely-missing')).rejects.toThrow(ManifestError);
          await expect(registry.getRealtimeCompat('registry-rt-object')).rejects.toThrow(ManifestError);
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('registry-rt-object'));

          await expect(registry.getRealtimeCompat('../evil')).rejects.toThrow(ManifestError);
        } finally {
          process.chdir(previousCwd);
          warnSpy.mockRestore();

          if (fs.existsSync(tempObject)) fs.unlinkSync(tempObject);
          if (fs.existsSync(localDuplicate)) fs.unlinkSync(localDuplicate);
          if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });

  });

  describe('realtime providers', () => {
    test('loads realtime provider manifests from plugins/realtime-providers and validates referenced realtime compats', async () => {
      await withTempCwd('registry-realtime-providers', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        process.env.TEST_LLM_ENDPOINT = 'http://localhost';

        const rtCompatLocal = path.join(pluginsDir, 'realtime-compat');
        fs.mkdirSync(rtCompatLocal, { recursive: true });
        fs.writeFileSync(
          path.join(rtCompatLocal, 'rt-validate-ok.js'),
          'module.exports = class RtValidateOk { constructor() { this.kind = \"ok\"; } }',
          'utf-8'
        );

        const rtProvidersDir = path.join(pluginsDir, 'realtime-providers');
        fs.mkdirSync(rtProvidersDir, { recursive: true });
        fs.writeFileSync(
          path.join(rtProvidersDir, 'test-rt.json'),
          JSON.stringify(
            {
              id: 'test-rt',
              compat: 'rt-validate-ok',
              endpoint: { urlTemplate: 'ws://localhost/realtime', headers: {} }
            },
            null,
            2
          ),
          'utf-8'
        );

        const registry = new PluginRegistry(pluginsDir);
        // Ensure we exercise strict loading path for realtime provider manifests.
        await expect(registry.validateAll()).resolves.toBeUndefined();

        const rt = await registry.getRealtimeProvider('test-rt');
        expect(rt.id).toBe('test-rt');
        expect(rt.compat).toBe('rt-validate-ok');
      });
    });

    test('validateAll fails when a realtime provider references a missing realtime compat', async () => {
      await withTempCwd('registry-realtime-providers-missing-compat', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const rtProvidersDir = path.join(pluginsDir, 'realtime-providers');
        fs.mkdirSync(rtProvidersDir, { recursive: true });
        fs.writeFileSync(
          path.join(rtProvidersDir, 'test-rt-missing.json'),
          JSON.stringify(
            {
              id: 'test-rt-missing',
              compat: 'rt-missing',
              endpoint: { urlTemplate: 'ws://localhost/realtime', headers: {} }
            },
            null,
            2
          ),
          'utf-8'
        );

        const registry = new PluginRegistry(pluginsDir);
        await expect(registry.getRealtimeProvider('test-rt-missing')).resolves.toBeDefined();
        await expect(registry.validateAll()).rejects.toThrow(ManifestError);
      });
    });

    test('non-strict loading skips invalid realtime provider manifests with a warning', async () => {
      await withTempCwd('registry-realtime-providers-invalid-json', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const rtProvidersDir = path.join(pluginsDir, 'realtime-providers');
        fs.mkdirSync(rtProvidersDir, { recursive: true });
        fs.writeFileSync(path.join(rtProvidersDir, 'invalid.json'), '{ invalid json', 'utf-8');

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const registry = new PluginRegistry(pluginsDir);
          await expect(registry.getRealtimeProvider('nonexistent')).rejects.toThrow(ManifestError);
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping realtime provider manifest'));
        } finally {
          warnSpy.mockRestore();
        }
      });
    });

    test('throws ManifestError for unknown realtime provider', async () => {
      await withTempCwd('registry-realtime-providers-missing', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const registry = new PluginRegistry(pluginsDir);
        await expect(registry.getRealtimeProvider('nonexistent')).rejects.toThrow(ManifestError);
      });
    });
  });

  describe('embedding providers and compats', () => {
    test('loads embedding provider config from plugins/embeddings', async () => {
      process.env.TEST_LLM_ENDPOINT = 'http://localhost';

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
        await expect(registry.validateAll()).resolves.toBeUndefined();
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
        const compatA = await registry.getEmbeddingCompat('openrouter');
        const compatB = await registry.getEmbeddingCompat('openrouter');

        expect(compatA).not.toBe(compatB);
        expect(typeof compatA.embed).toBe('function');
        expect(typeof compatA.getDimensions).toBe('function');
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

	          let compatKeys = Array.from((registry as any).embeddingCompats.keys());
	          expect(compatKeys).toEqual(expect.arrayContaining(['openrouter', 'embed-test-temp']));
	          expect(compatKeys).not.toContain('embed-test-named');
	          expect(compatKeys).not.toContain('embed-test-dts');
	          await expect(registry.getEmbeddingCompat('embed-test-broken')).rejects.toThrow(ManifestError);
	          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('embed-test-broken'));
	          expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('embed-test-dts'))).toBe(false);
	          const tempCompat = await registry.getEmbeddingCompat('embed-test-temp');
	          expect(tempCompat.kind).toBe('js');
	          // Test named export fallback
	          const namedCompat = await registry.getEmbeddingCompat('embed-test-named');
	          expect(namedCompat.kind).toBe('named');
	          compatKeys = Array.from((registry as any).embeddingCompats.keys());
	          expect(compatKeys).toEqual(expect.arrayContaining(['openrouter', 'embed-test-temp', 'embed-test-named']));
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

	          let compatKeys = Array.from((registry as any).vectorStoreCompats.keys());
	          expect(compatKeys).toEqual(expect.arrayContaining(['memory', 'vector-test-temp']));
	          expect(compatKeys).not.toContain('vector-test-named');
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
	          compatKeys = Array.from((registry as any).vectorStoreCompats.keys());
	          expect(compatKeys).toEqual(expect.arrayContaining(['memory', 'vector-test-temp', 'vector-test-named']));
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

  describe('validation hardening', () => {
    test('rejects invalid plugin module names (path traversal)', async () => {
      await withTempCwd('registry-invalid-module-name', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const registry = new PluginRegistry(pluginsDir);
        await expect(registry.getCompatModule('.')).rejects.toThrow(ManifestError);
        await expect(registry.getCompatModule('..')).rejects.toThrow(ManifestError);
        await expect(registry.getCompatModule('../evil')).rejects.toThrow(ManifestError);
        await expect(registry.getEmbeddingCompat('.')).rejects.toThrow(ManifestError);
        await expect(registry.getEmbeddingCompat('..')).rejects.toThrow(ManifestError);
        await expect(registry.getEmbeddingCompat('../evil')).rejects.toThrow(ManifestError);
        await expect(registry.getVectorStoreCompat('.')).rejects.toThrow(ManifestError);
        await expect(registry.getVectorStoreCompat('..')).rejects.toThrow(ManifestError);
        await expect(registry.getVectorStoreCompat('../evil')).rejects.toThrow(ManifestError);
        await expect(registry.getRealtimeCompat('.')).rejects.toThrow(ManifestError);
        await expect(registry.getRealtimeCompat('..')).rejects.toThrow(ManifestError);
      });
    });

    test('validateAll preloads manifests + plugin code (opt-in)', async () => {
      process.env.TEST_LLM_ENDPOINT = 'http://localhost';

      await withTempCwd('registry-validate-all', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const registry = new PluginRegistry(pluginsDir);

        await expect((registry as any).validateAll()).resolves.toBeUndefined();

        // validateAll should not change the semantics of getCompatModule: still returns fresh instances
        const a = await registry.getCompatModule('openai');
        const b = await registry.getCompatModule('openai');
        expect(a).not.toBe(b);
      });
    });

    test('validateAll fails fast when a provider references a missing compat', async () => {
      process.env.TEST_LLM_ENDPOINT = 'http://localhost';

      await withTempCwd('registry-validate-all-missing-compat', async (dir) => {
        const pluginsDir = path.join(dir, 'plugins');
        copyFixturePlugins(pluginsDir);

        const providersDir = path.join(pluginsDir, 'providers');
        fs.writeFileSync(
          path.join(providersDir, 'bad.json'),
          JSON.stringify(
            {
              id: 'bad-provider',
              compat: 'definitely-missing',
              endpoint: { urlTemplate: 'http://localhost/{model}', method: 'POST', headers: {} }
            },
            null,
            2
          ),
          'utf-8'
        );

        const registry = new PluginRegistry(pluginsDir);
        await expect((registry as any).validateAll()).rejects.toThrow(ManifestError);
      });
    });
  });
});
