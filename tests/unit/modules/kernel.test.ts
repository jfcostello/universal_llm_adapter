import { jest } from '@jest/globals';

describe('kernel', () => {
  test('imports without eagerly loading feature code', async () => {
    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      // If kernel starts pulling in feature code, these mocks will fail the import.
      jest.unstable_mockModule('../../../modules/server/index.js', () => {
        throw new Error('kernel must not import server module');
      });
      jest.unstable_mockModule('../../../modules/tools/index.js', () => {
        throw new Error('kernel must not import tools module');
      });
      jest.unstable_mockModule('../../../modules/mcp/index.js', () => {
        throw new Error('kernel must not import MCP module');
      });
      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        throw new Error('kernel must not import vector module');
      });
      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        throw new Error('kernel must not import embeddings module');
      });
      jest.unstable_mockModule('../../../modules/llm/index.js', () => {
        throw new Error('kernel must not import llm module');
      });
      jest.unstable_mockModule('../../../modules/logging/index.js', () => {
        throw new Error('kernel must not import logging module');
      });
      jest.unstable_mockModule('../../../modules/cli/index.js', () => {
        throw new Error('kernel must not import cli module');
      });
      jest.unstable_mockModule('../../../modules/context/index.js', () => {
        throw new Error('kernel must not import context module');
      });
      jest.unstable_mockModule('../../../modules/documents/index.js', () => {
        throw new Error('kernel must not import documents module');
      });
      jest.unstable_mockModule('../../../modules/lifecycle/index.js', () => {
        throw new Error('kernel must not import lifecycle module');
      });
      jest.unstable_mockModule('../../../modules/messages/index.js', () => {
        throw new Error('kernel must not import messages module');
      });
      jest.unstable_mockModule('../../../modules/retry/index.js', () => {
        throw new Error('kernel must not import retry module');
      });
      jest.unstable_mockModule('../../../modules/security/index.js', () => {
        throw new Error('kernel must not import security module');
      });
      jest.unstable_mockModule('../../../modules/settings/index.js', () => {
        throw new Error('kernel must not import settings module');
      });
      jest.unstable_mockModule('../../../modules/string/index.js', () => {
        throw new Error('kernel must not import string module');
      });
      jest.unstable_mockModule('../../../modules/usage/index.js', () => {
        throw new Error('kernel must not import usage module');
      });
      jest.unstable_mockModule('../../../modules/observability/index.js', () => {
        throw new Error('kernel must not import observability module');
      });

      const kernel = await import('@/kernel/index.ts');

      // Spot check a few key exports (full API will evolve).
      expect(kernel.PluginRegistry).toBeDefined();
      expect(kernel.getDefaults).toBeDefined();
      expect(kernel.ManifestError).toBeDefined();
    });
  });
});
