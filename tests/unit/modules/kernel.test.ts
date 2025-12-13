import { jest } from '@jest/globals';

describe('modules/kernel', () => {
  test('imports without eagerly loading feature code', async () => {
    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      // If kernel starts pulling in feature code, these mocks will fail the import.
      jest.unstable_mockModule('../../../utils/server/index.js', () => {
        throw new Error('kernel must not import server module');
      });
      jest.unstable_mockModule('../../../utils/tools/tool-coordinator.js', () => {
        throw new Error('kernel must not import tools module');
      });
      jest.unstable_mockModule('../../../managers/mcp-manager.js', () => {
        throw new Error('kernel must not import MCP manager');
      });
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => {
        throw new Error('kernel must not import MCP module');
      });
      jest.unstable_mockModule('../../../mcp/mcp-client.js', () => {
        throw new Error('kernel must not import MCP client');
      });
      jest.unstable_mockModule('../../../mcp/mcp-manifest.js', () => {
        throw new Error('kernel must not import MCP manifest parser');
      });
      jest.unstable_mockModule('../../../coordinator/coordinator.js', () => {
        throw new Error('kernel must not import coordinators');
      });

      const kernel = await import('@/modules/kernel/index.ts');

      // Spot check a few key exports (full API will evolve).
      expect(kernel.PluginRegistry).toBeDefined();
      expect(kernel.getDefaults).toBeDefined();
      expect(kernel.ManifestError).toBeDefined();
    });
  });
});
