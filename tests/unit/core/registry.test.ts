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
});
