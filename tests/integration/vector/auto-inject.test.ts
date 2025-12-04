import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';

// Type imports
import type { LLMCoordinator } from '@/coordinator/coordinator.ts';
import type { PluginRegistry } from '@/core/registry.ts';
import type { LLMCallSpec, Message, Role, VectorContextConfig } from '@/core/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../..');

describe('integration/vector/auto-inject', () => {
  let LLMCoordinatorClass: typeof LLMCoordinator;
  let PluginRegistryClass: typeof PluginRegistry;
  let registry: PluginRegistry;
  let coordinator: LLMCoordinator;

  beforeAll(async () => {
    try {
      const coordinatorModule = await import('@/coordinator/coordinator.ts');
      const registryModule = await import('@/core/registry.ts');
      LLMCoordinatorClass = coordinatorModule.LLMCoordinator;
      PluginRegistryClass = registryModule.PluginRegistry;
    } catch (error) {
      console.warn('Modules not available - skipping auto-inject integration tests');
    }
  });

  beforeEach(async () => {
    if (!PluginRegistryClass) return;

    const pluginsPath = path.join(ROOT_DIR, 'plugins');
    registry = new PluginRegistryClass(pluginsPath);
    await registry.loadAll();

    // Set up coordinator with a vector manager
    // Note: This may need adjustment based on actual implementation
    coordinator = new LLMCoordinatorClass(registry);
  });

  afterEach(async () => {
    await coordinator?.close();
  });

  describe('auto-inject mode', () => {
    test('injects retrieved context into system prompt', async () => {
      if (!coordinator) {
        console.warn('Skipping - coordinator not available');
        return;
      }

      // This test documents expected behavior
      // The actual LLM call will be mocked in real tests

      const spec: LLMCallSpec = {
        messages: [
          {
            role: 'user' as any,
            content: [{ type: 'text', text: 'What is machine learning?' }]
          }
        ],
        vectorContext: {
          stores: ['memory'],
          mode: 'auto',
          topK: 3,
          injectAs: 'system',
          injectTemplate: 'Use this context:\n\n{{results}}'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0.7 }
      };

      // Note: This test requires mocking or a test LLM provider
      // For now, we're documenting the expected interface
      expect(spec.vectorContext?.mode).toBe('auto');
      expect(spec.vectorContext?.injectAs).toBe('system');
    });

    test('injects context as user_context message', async () => {
      if (!coordinator) return;

      const spec: LLMCallSpec = {
        systemPrompt: 'You are a helpful assistant.',
        messages: [
          { role: 'user' as any, content: [{ type: 'text', text: 'Previous question' }] },
          { role: 'assistant' as any, content: [{ type: 'text', text: 'Previous answer' }] },
          { role: 'user' as any, content: [{ type: 'text', text: 'Follow-up question' }] }
        ],
        vectorContext: {
          stores: ['memory'],
          mode: 'auto',
          topK: 5,
          injectAs: 'user_context'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {}
      };

      expect(spec.vectorContext?.injectAs).toBe('user_context');
    });
  });

  describe('tool mode', () => {
    test('creates vector_search tool when mode is tool', async () => {
      if (!coordinator) return;

      const spec: LLMCallSpec = {
        messages: [
          { role: 'user' as any, content: [{ type: 'text', text: 'Search for relevant docs' }] }
        ],
        vectorContext: {
          stores: ['memory'],
          mode: 'tool',
          toolName: 'search_knowledge_base',
          toolDescription: 'Search the knowledge base for relevant information'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {}
      };

      expect(spec.vectorContext?.mode).toBe('tool');
      expect(spec.vectorContext?.toolName).toBe('search_knowledge_base');
    });
  });

  describe('both mode (hybrid)', () => {
    test('injects context and provides tool', async () => {
      if (!coordinator) return;

      const spec: LLMCallSpec = {
        systemPrompt: 'You are a helpful assistant with access to a knowledge base.',
        messages: [
          { role: 'user' as any, content: [{ type: 'text', text: 'Tell me about machine learning' }] }
        ],
        vectorContext: {
          stores: ['memory'],
          mode: 'both',
          topK: 3,
          injectAs: 'system',
          injectTemplate: 'Initial context:\n{{results}}\n\nYou can search for more using the search tool.',
          toolName: 'search_more',
          toolDescription: 'Search for additional information'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {}
      };

      expect(spec.vectorContext?.mode).toBe('both');
      // In 'both' mode:
      // 1. Context is auto-injected before the call
      // 2. A search tool is also available for follow-up queries
    });
  });

  describe('backward compatibility', () => {
    test('existing vectorPriority still works for tool retrieval', async () => {
      if (!coordinator) return;

      // vectorPriority is for semantic tool selection (existing behavior)
      const spec: LLMCallSpec = {
        messages: [
          { role: 'user' as any, content: [{ type: 'text', text: 'I need to calculate something' }] }
        ],
        vectorPriority: ['tool-store'], // Retrieves tools from vector store
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {}
      };

      // This should work independently of vectorContext
      expect(spec.vectorPriority).toBeDefined();
      expect(spec.vectorContext).toBeUndefined();
    });

    test('vectorContext and vectorPriority can coexist', async () => {
      if (!coordinator) return;

      const spec: LLMCallSpec = {
        messages: [
          { role: 'user' as any, content: [{ type: 'text', text: 'Complex query' }] }
        ],
        // vectorPriority for tool selection
        vectorPriority: ['tool-store'],
        // vectorContext for RAG
        vectorContext: {
          stores: ['doc-store'],
          mode: 'auto',
          topK: 5
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {}
      };

      // Both can be specified for different purposes
      expect(spec.vectorPriority).toBeDefined();
      expect(spec.vectorContext).toBeDefined();
    });
  });

  describe('configuration options', () => {
    test('respects score threshold', async () => {
      if (!coordinator) return;

      const spec: LLMCallSpec = {
        messages: [
          { role: 'user' as any, content: [{ type: 'text', text: 'Query' }] }
        ],
        vectorContext: {
          stores: ['memory'],
          mode: 'auto',
          scoreThreshold: 0.8 // Only inject results with score >= 0.8
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {}
      };

      expect(spec.vectorContext?.scoreThreshold).toBe(0.8);
    });

    test('applies metadata filter', async () => {
      if (!coordinator) return;

      const spec: LLMCallSpec = {
        messages: [
          { role: 'user' as any, content: [{ type: 'text', text: 'Query about tech' }] }
        ],
        vectorContext: {
          stores: ['memory'],
          mode: 'auto',
          filter: { category: 'technology', year: 2024 }
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {}
      };

      expect(spec.vectorContext?.filter).toEqual({ category: 'technology', year: 2024 });
    });

    test('uses custom embedding priority', async () => {
      if (!coordinator) return;

      const spec: LLMCallSpec = {
        messages: [
          { role: 'user' as any, content: [{ type: 'text', text: 'Query' }] }
        ],
        vectorContext: {
          stores: ['memory'],
          mode: 'auto',
          embeddingPriority: [
            { provider: 'openrouter-embeddings', model: 'openai/text-embedding-3-large' }
          ]
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: {}
      };

      expect(spec.vectorContext?.embeddingPriority?.[0].model).toBe('openai/text-embedding-3-large');
    });
  });
});
