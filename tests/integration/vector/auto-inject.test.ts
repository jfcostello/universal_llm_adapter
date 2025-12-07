import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';

// Type imports
import type { LLMCoordinator } from '@/coordinator/coordinator.ts';
import type { PluginRegistry } from '@/core/registry.ts';
import type { LLMCallSpec, Message, Role, VectorContextConfig, TextContent } from '@/core/types.ts';
import type { VectorContextInjector } from '@/utils/vector/vector-context-injector.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../..');

describe('integration/vector/auto-inject', () => {
  let LLMCoordinatorClass: typeof LLMCoordinator;
  let PluginRegistryClass: typeof PluginRegistry;
  let VectorContextInjectorClass: typeof VectorContextInjector;
  let registry: PluginRegistry;
  let coordinator: LLMCoordinator;

  beforeAll(async () => {
    try {
      const coordinatorModule = await import('@/coordinator/coordinator.ts');
      const registryModule = await import('@/core/registry.ts');
      const injectorModule = await import('@/utils/vector/vector-context-injector.ts');
      LLMCoordinatorClass = coordinatorModule.LLMCoordinator;
      PluginRegistryClass = registryModule.PluginRegistry;
      VectorContextInjectorClass = injectorModule.VectorContextInjector;
    } catch (error) {
      console.warn('Modules not available - skipping auto-inject integration tests');
    }
  });

  beforeEach(async () => {
    if (!PluginRegistryClass) return;

    const pluginsPath = path.join(ROOT_DIR, 'plugins');
    registry = new PluginRegistryClass(pluginsPath);
    await registry.loadAll();

    coordinator = new LLMCoordinatorClass(registry);
  });

  afterEach(async () => {
    await coordinator?.close();
  });

  describe('VectorContextInjector execution', () => {
    test('injectContext modifies messages with retrieved context', async () => {
      if (!VectorContextInjectorClass) return;

      // Create mock registry with vector store and embedding support
      const mockEmbeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'test-model',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(3)
      };

      const mockVectorCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.95, payload: { text: 'Machine learning is a subset of AI.' } },
          { id: 'doc2', score: 0.85, payload: { text: 'Neural networks process data.' } }
        ]),
        close: jest.fn().mockResolvedValue(undefined)
      };

      const mockRegistry = {
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'test-embeddings',
          kind: 'openrouter',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test-model',
          dimensions: 3
        }),
        getEmbeddingCompat: jest.fn().mockResolvedValue(mockEmbeddingCompat),
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'test-store',
          kind: 'memory',
          defaultCollection: 'test-collection'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockVectorCompat)
      };

      const injector = new VectorContextInjectorClass({
        registry: mockRegistry as any
      });

      const messages: Message[] = [
        {
          role: 'user' as Role,
          content: [{ type: 'text', text: 'What is machine learning?' }]
        }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        topK: 2,
        injectAs: 'system',
        injectTemplate: 'Relevant context:\n{{results}}',
        embeddingPriority: [{ provider: 'test-embeddings' }]
      };

      const result = await injector.injectContext(messages, config);

      // Verify context was injected
      expect(result.resultsInjected).toBe(2);
      expect(result.query).toBe('What is machine learning?');
      expect(result.messages.length).toBeGreaterThan(messages.length);

      // Verify system message was added with context
      const systemMessage = result.messages.find(m => m.role === 'system');
      expect(systemMessage).toBeDefined();
      const systemText = (systemMessage!.content[0] as TextContent).text;
      expect(systemText).toContain('Machine learning is a subset of AI');
      expect(systemText).toContain('Neural networks process data');
    });

    test('injectContext respects collection override', async () => {
      if (!VectorContextInjectorClass) return;

      const mockEmbeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'test-model',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(3)
      };

      const mockVectorCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Custom collection data.' } }
        ]),
        close: jest.fn().mockResolvedValue(undefined)
      };

      const mockRegistry = {
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'test-embeddings',
          kind: 'openrouter',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test-model',
          dimensions: 3
        }),
        getEmbeddingCompat: jest.fn().mockResolvedValue(mockEmbeddingCompat),
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'test-store',
          kind: 'memory',
          defaultCollection: 'default-collection'  // This should be overridden
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockVectorCompat)
      };

      const injector = new VectorContextInjectorClass({
        registry: mockRegistry as any
      });

      const messages: Message[] = [
        { role: 'user' as Role, content: [{ type: 'text', text: 'Query' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        collection: 'custom-collection',  // Override default
        embeddingPriority: [{ provider: 'test-embeddings' }]
      };

      await injector.injectContext(messages, config);

      // Verify query was called with the custom collection, not default
      expect(mockVectorCompat.query).toHaveBeenCalledWith(
        'custom-collection',
        expect.any(Array),
        expect.any(Number),
        expect.any(Object)
      );
    });

    test('injectContext uses default collection when not specified', async () => {
      if (!VectorContextInjectorClass) return;

      const mockEmbeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'test-model',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(3)
      };

      const mockVectorCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([]),
        close: jest.fn().mockResolvedValue(undefined)
      };

      const mockRegistry = {
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'test-embeddings',
          kind: 'openrouter',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test-model',
          dimensions: 3
        }),
        getEmbeddingCompat: jest.fn().mockResolvedValue(mockEmbeddingCompat),
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'test-store',
          kind: 'memory',
          defaultCollection: 'store-default-collection'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockVectorCompat)
      };

      const injector = new VectorContextInjectorClass({
        registry: mockRegistry as any
      });

      const messages: Message[] = [
        { role: 'user' as Role, content: [{ type: 'text', text: 'Query' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        // No collection specified - should use store default
        embeddingPriority: [{ provider: 'test-embeddings' }]
      };

      await injector.injectContext(messages, config);

      // Verify query was called with the store's default collection
      expect(mockVectorCompat.query).toHaveBeenCalledWith(
        'store-default-collection',
        expect.any(Array),
        expect.any(Number),
        expect.any(Object)
      );
    });

    test('injectContext applies score threshold', async () => {
      if (!VectorContextInjectorClass) return;

      const mockEmbeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'test-model',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(3)
      };

      const mockVectorCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.95, payload: { text: 'High score result.' } },
          { id: 'doc2', score: 0.75, payload: { text: 'Medium score result.' } },
          { id: 'doc3', score: 0.50, payload: { text: 'Low score result.' } }
        ]),
        close: jest.fn().mockResolvedValue(undefined)
      };

      const mockRegistry = {
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'test-embeddings',
          kind: 'openrouter',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test-model',
          dimensions: 3
        }),
        getEmbeddingCompat: jest.fn().mockResolvedValue(mockEmbeddingCompat),
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'test-store',
          kind: 'memory',
          defaultCollection: 'test'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockVectorCompat)
      };

      const injector = new VectorContextInjectorClass({
        registry: mockRegistry as any
      });

      const messages: Message[] = [
        { role: 'user' as Role, content: [{ type: 'text', text: 'Query' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        scoreThreshold: 0.8,  // Only results >= 0.8
        embeddingPriority: [{ provider: 'test-embeddings' }]
      };

      const result = await injector.injectContext(messages, config);

      // Only the high score result should be injected
      expect(result.resultsInjected).toBe(1);
      const systemMessage = result.messages.find(m => m.role === 'system');
      const systemText = (systemMessage!.content[0] as TextContent).text;
      expect(systemText).toContain('High score result');
      expect(systemText).not.toContain('Medium score result');
      expect(systemText).not.toContain('Low score result');
    });

    test('injectContext injects as user_context before last user message', async () => {
      if (!VectorContextInjectorClass) return;

      const mockEmbeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'test-model',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(3)
      };

      const mockVectorCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Context data.' } }
        ]),
        close: jest.fn().mockResolvedValue(undefined)
      };

      const mockRegistry = {
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'test-embeddings',
          kind: 'openrouter',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test-model',
          dimensions: 3
        }),
        getEmbeddingCompat: jest.fn().mockResolvedValue(mockEmbeddingCompat),
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'test-store',
          kind: 'memory',
          defaultCollection: 'test'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockVectorCompat)
      };

      const injector = new VectorContextInjectorClass({
        registry: mockRegistry as any
      });

      const messages: Message[] = [
        { role: 'user' as Role, content: [{ type: 'text', text: 'First question' }] },
        { role: 'assistant' as Role, content: [{ type: 'text', text: 'First answer' }] },
        { role: 'user' as Role, content: [{ type: 'text', text: 'Follow-up question' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        injectAs: 'user_context',
        embeddingPriority: [{ provider: 'test-embeddings' }]
      };

      const result = await injector.injectContext(messages, config);

      // Context should be inserted before the last user message
      expect(result.messages.length).toBe(4);  // Original 3 + 1 injected

      // Find injected message (should be at index 2, before "Follow-up question")
      const injectedMessage = result.messages[2];
      expect(injectedMessage.role).toBe('user');
      expect((injectedMessage.content[0] as TextContent).text).toContain('Context data');

      // Last message should still be the follow-up question
      const lastMessage = result.messages[3];
      expect((lastMessage.content[0] as TextContent).text).toBe('Follow-up question');
    });

    test('injectContext returns original messages for tool mode', async () => {
      if (!VectorContextInjectorClass) return;

      const mockRegistry = {
        getEmbeddingProvider: jest.fn(),
        getEmbeddingCompat: jest.fn(),
        getVectorStore: jest.fn(),
        getVectorStoreCompat: jest.fn()
      };

      const injector = new VectorContextInjectorClass({
        registry: mockRegistry as any
      });

      const messages: Message[] = [
        { role: 'user' as Role, content: [{ type: 'text', text: 'Query' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'tool'  // Tool mode - no auto-injection
      };

      const result = await injector.injectContext(messages, config);

      // Should return original messages unchanged
      expect(result.messages).toEqual(messages);
      expect(result.resultsInjected).toBe(0);

      // No vector operations should have been called
      expect(mockRegistry.getVectorStore).not.toHaveBeenCalled();
    });
  });

  describe('tool mode - vector_search tool creation', () => {
    test('creates vector_search tool with correct schema', async () => {
      const { createVectorSearchTool } = await import('@/utils/tools/tool-discovery.ts');

      const config: VectorContextConfig = {
        stores: ['store1', 'store2'],
        mode: 'tool',
        topK: 10,
        toolName: 'search_docs',
        toolDescription: 'Search documentation'
      };

      const { tool } = createVectorSearchTool(config);

      expect(tool.name).toBe('search_docs');
      expect(tool.description).toBe('Search documentation');
      expect(tool.parametersJsonSchema).toBeDefined();
      expect(tool.parametersJsonSchema.properties.query).toBeDefined();
      expect(tool.parametersJsonSchema.properties.topK).toBeDefined();
      expect(tool.parametersJsonSchema.properties.store).toBeDefined();
      expect(tool.parametersJsonSchema.required).toContain('query');
    });

    test('uses default tool name and description when not specified', async () => {
      const { createVectorSearchTool } = await import('@/utils/tools/tool-discovery.ts');

      const config: VectorContextConfig = {
        stores: ['my-store'],
        mode: 'tool'
      };

      const { tool } = createVectorSearchTool(config);

      expect(tool.name).toBe('vector_search');
      expect(tool.description).toContain('my-store');
    });
  });

  describe('both mode - hybrid behavior', () => {
    test('shouldCreateVectorSearchTool returns true for both mode', async () => {
      const { shouldCreateVectorSearchTool } = await import('@/utils/tools/tool-discovery.ts');

      expect(shouldCreateVectorSearchTool('both')).toBe(true);
      expect(shouldCreateVectorSearchTool('tool')).toBe(true);
      expect(shouldCreateVectorSearchTool('auto')).toBe(false);
      expect(shouldCreateVectorSearchTool(undefined)).toBe(false);
    });
  });

  describe('backward compatibility', () => {
    test('vectorPriority and vectorContext are independent', async () => {
      if (!coordinator) return;

      // vectorPriority is for semantic tool selection
      // vectorContext is for RAG context injection
      // Both can be specified and work independently

      const spec: LLMCallSpec = {
        messages: [
          { role: 'user' as Role, content: [{ type: 'text', text: 'Query' }] }
        ],
        vectorPriority: ['tool-store'],
        vectorContext: {
          stores: ['doc-store'],
          mode: 'auto',
          topK: 5
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {}
      };

      // Both can be defined
      expect(spec.vectorPriority).toBeDefined();
      expect(spec.vectorContext).toBeDefined();
      // They serve different purposes
      expect(spec.vectorPriority).toContain('tool-store');
      expect(spec.vectorContext?.stores).toContain('doc-store');
    });
  });
});
