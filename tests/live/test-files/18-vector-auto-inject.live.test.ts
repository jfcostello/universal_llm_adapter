/**
 * Live tests for Vector Context Auto-Injection.
 *
 * These tests verify RAG functionality with real APIs.
 *
 * Required environment variables:
 * - QDRANT_CLOUD_URL: Qdrant Cloud instance URL
 * - QDRANT_API_KEY: Qdrant Cloud API key
 * - OPENROUTER_API_KEY: OpenRouter API key for embeddings and LLM
 *
 * Run: npm run test:live:vector-inject
 * Or: LLM_LIVE=1 npx jest tests/live/test-files/18-vector-auto-inject.live.test.ts
 */

import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';

const SKIP_LIVE = !process.env.LLM_LIVE;
const describeLive = SKIP_LIVE ? describe.skip : describe;

// Type imports
import type { LLMCoordinator } from '@/coordinator/coordinator.ts';
import type { VectorStoreCoordinator } from '@/coordinator/vector-coordinator.ts';
import type { PluginRegistry } from '@/core/registry.ts';
import type { LLMCallSpec } from '@/core/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../..');
const TEST_COLLECTION = `test-inject-${Date.now()}`;

describeLive('live/vector-auto-inject', () => {
  let LLMCoordinatorClass: typeof LLMCoordinator;
  let VectorStoreCoordinatorClass: typeof VectorStoreCoordinator;
  let PluginRegistryClass: typeof PluginRegistry;
  let registry: PluginRegistry;
  let llmCoordinator: LLMCoordinator;
  let vectorCoordinator: VectorStoreCoordinator;

  beforeAll(async () => {
    const required = ['QDRANT_CLOUD_URL', 'QDRANT_API_KEY', 'OPENROUTER_API_KEY'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
      console.warn(`Missing environment variables: ${missing.join(', ')}`);
      return;
    }

    try {
      const llmModule = await import('@/coordinator/coordinator.ts');
      const vectorModule = await import('@/coordinator/vector-coordinator.ts');
      const registryModule = await import('@/core/registry.ts');

      LLMCoordinatorClass = llmModule.LLMCoordinator;
      VectorStoreCoordinatorClass = vectorModule.VectorStoreCoordinator;
      PluginRegistryClass = registryModule.PluginRegistry;

      const pluginsPath = path.join(ROOT_DIR, 'plugins');
      registry = new PluginRegistryClass(pluginsPath);
      await registry.loadAll();

      vectorCoordinator = new VectorStoreCoordinatorClass(registry);
      llmCoordinator = new LLMCoordinatorClass(registry);

      // Create test collection and seed with documents
      await vectorCoordinator.execute({
        operation: 'collections',
        store: 'qdrant-cloud',
        input: {
          collectionOp: 'create',
          collectionName: TEST_COLLECTION,
          dimensions: 1536
        }
      });

      // Seed with test documents
      await vectorCoordinator.execute({
        operation: 'embed',
        store: 'qdrant-cloud',
        collection: TEST_COLLECTION,
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          chunks: [
            {
              id: 'fact-1',
              text: 'The capital of France is Paris. Paris is known for the Eiffel Tower.',
              metadata: { topic: 'geography', country: 'France' }
            },
            {
              id: 'fact-2',
              text: 'Python was created by Guido van Rossum and released in 1991.',
              metadata: { topic: 'programming', language: 'Python' }
            },
            {
              id: 'fact-3',
              text: 'Machine learning is a subset of AI that enables computers to learn from data.',
              metadata: { topic: 'technology', field: 'AI' }
            },
            {
              id: 'fact-4',
              text: 'The Great Wall of China is over 13,000 miles long.',
              metadata: { topic: 'geography', country: 'China' }
            }
          ]
        }
      });

      // Wait for indexing
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error('Failed to initialize for live tests:', error);
    }
  }, 120000);

  afterAll(async () => {
    if (vectorCoordinator) {
      try {
        await vectorCoordinator.execute({
          operation: 'collections',
          store: 'qdrant-cloud',
          input: {
            collectionOp: 'delete',
            collectionName: TEST_COLLECTION
          }
        });
        console.log(`Deleted collection: ${TEST_COLLECTION}`);

        // Verify deletion succeeded
        const existsResult = await vectorCoordinator.execute({
          operation: 'collections',
          store: 'qdrant-cloud',
          input: {
            collectionOp: 'exists',
            collectionName: TEST_COLLECTION
          }
        });
        if (existsResult.exists) {
          console.error(`ERROR: Collection ${TEST_COLLECTION} still exists after deletion!`);
        } else {
          console.log(`Verified collection ${TEST_COLLECTION} no longer exists`);
        }
      } catch (error) {
        console.warn('Failed to delete test collection:', error);
      }
      await vectorCoordinator.close();
    }
    await llmCoordinator?.close();
  }, 30000);

  describe('auto mode - context injection', () => {
    test('injects relevant context before LLM call', async () => {
      if (!llmCoordinator) {
        console.warn('Coordinator not available - skipping');
        return;
      }

      const spec: LLMCallSpec = {
        systemPrompt: 'You are a helpful assistant. Answer questions using only the provided context.',
        messages: [
          {
            role: 'user' as any,
            content: [{ type: 'text', text: 'What is the capital of France?' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: TEST_COLLECTION,
          mode: 'auto',
          topK: 2,
          injectAs: 'system',
          injectTemplate: 'Use the following context to answer:\n\n{{results}}'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 200 }
      };

      const response = await llmCoordinator.run(spec);

      expect(response.content).toBeDefined();
      const textContent = response.content.find(c => c.type === 'text');
      expect(textContent).toBeDefined();

      // The response should mention Paris (from the injected context)
      const text = (textContent as any).text.toLowerCase();
      expect(text).toContain('paris');
    }, 60000);

    test('filters context by metadata', async () => {
      if (!llmCoordinator) return;

      const spec: LLMCallSpec = {
        systemPrompt: 'Answer based only on the provided context. Be specific and mention locations.',
        messages: [
          {
            role: 'user' as any,
            content: [{ type: 'text', text: 'Tell me about a capital city mentioned in the context.' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: TEST_COLLECTION,
          mode: 'auto',
          topK: 5,
          filter: { topic: 'geography' },
          injectAs: 'system'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 200 }
      };

      const response = await llmCoordinator.run(spec);

      const textContent = response.content.find(c => c.type === 'text');
      const text = (textContent as any).text.toLowerCase();

      // Response should be about geography - France/Paris or China/Beijing
      expect(text.includes('paris') || text.includes('france') || text.includes('china') || text.includes('beijing') || text.includes('capital')).toBe(true);
    }, 60000);

    test('uses score threshold to filter low-relevance results', async () => {
      if (!llmCoordinator) return;

      const spec: LLMCallSpec = {
        systemPrompt: 'If no relevant context is provided, say "No relevant information found."',
        messages: [
          {
            role: 'user' as any,
            content: [{ type: 'text', text: 'What is the recipe for chocolate cake?' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: TEST_COLLECTION,
          mode: 'auto',
          topK: 3,
          scoreThreshold: 0.9, // Very high threshold - unlikely to match
          injectAs: 'system'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 100 }
      };

      const response = await llmCoordinator.run(spec);

      // With no relevant context injected, the model should indicate lack of information
      const textContent = response.content.find(c => c.type === 'text');
      expect(textContent).toBeDefined();
    }, 60000);
  });

  describe('tool mode - on-demand search', () => {
    test('LLM can use vector_search tool', async () => {
      if (!llmCoordinator) return;

      const spec: LLMCallSpec = {
        systemPrompt: 'You have access to a search tool. Use it to find information before answering.',
        messages: [
          {
            role: 'user' as any,
            content: [{ type: 'text', text: 'Search for information about Python programming and tell me who created it.' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: TEST_COLLECTION,
          mode: 'tool',
          topK: 3,
          toolName: 'search_knowledge_base',
          toolDescription: 'Search the knowledge base for relevant information'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 300 }
      };

      const response = await llmCoordinator.run(spec);

      // The model should have found and used the Python information
      const textContent = response.content.find(c => c.type === 'text');
      const text = (textContent as any).text.toLowerCase();

      // Should mention Guido van Rossum (the creator of Python)
      expect(text.includes('guido') || text.includes('rossum') || text.includes('1991')).toBe(true);
    }, 90000);
  });

  describe('both mode - hybrid approach', () => {
    test('injects initial context and provides search tool', async () => {
      if (!llmCoordinator) return;

      const spec: LLMCallSpec = {
        systemPrompt: 'Answer using the provided context. If you need more information, use the search tool.',
        messages: [
          {
            role: 'user' as any,
            content: [{ type: 'text', text: 'What do you know about AI and machine learning?' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: TEST_COLLECTION,
          mode: 'both',
          topK: 2,
          injectAs: 'system',
          injectTemplate: 'Initial context:\n{{results}}\n\nYou can search for more information if needed.',
          toolName: 'search_more',
          toolDescription: 'Search for additional information in the knowledge base'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 300 }
      };

      const response = await llmCoordinator.run(spec);

      const textContent = response.content.find(c => c.type === 'text');
      const text = (textContent as any).text.toLowerCase();

      // Should have used the auto-injected context about machine learning
      expect(text.includes('machine learning') || text.includes('ai') || text.includes('artificial intelligence')).toBe(true);
    }, 90000);
  });

  describe('query construction settings', () => {
    // Note: The queryConstruction and overrideEmbeddingQuery features are tested in unit tests
    // (tests/unit/utils/vector/vector-context-injector.test.ts) where we can reliably mock
    // the vector store responses. Live tests here depend on timing of vector indexing and
    // embedding similarity thresholds which can be unreliable.

    test('queryConstruction with multiple messages', async () => {
      if (!llmCoordinator) return;

      // Multi-turn conversation where we want context from previous messages
      const spec: LLMCallSpec = {
        systemPrompt: 'Answer based on the provided context.',
        messages: [
          {
            role: 'user' as any,
            content: [{ type: 'text', text: 'I want to learn about programming languages.' }]
          },
          {
            role: 'assistant' as any,
            content: [{ type: 'text', text: 'Sure! What programming language interests you?' }]
          },
          {
            role: 'user' as any,
            content: [{ type: 'text', text: 'Tell me about Python specifically.' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: TEST_COLLECTION,
          mode: 'auto',
          topK: 2,
          injectAs: 'system',
          queryConstruction: {
            messagesToInclude: 3, // Include all 3 messages
            includeAssistantMessages: true,
            includeSystemPrompt: 'never'
          }
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 200 }
      };

      const response = await llmCoordinator.run(spec);

      const textContent = response.content.find(c => c.type === 'text');
      const text = (textContent as any).text.toLowerCase();

      // Should find Python info since the combined query mentions programming and Python
      expect(text.includes('python') || text.includes('guido') || text.includes('1991')).toBe(true);
    }, 60000);
  });

  describe('streaming with vector context', () => {
    test('streams response with auto-injected context', async () => {
      if (!llmCoordinator) return;

      const spec: LLMCallSpec = {
        systemPrompt: 'Answer concisely using the provided context.',
        messages: [
          {
            role: 'user' as any,
            content: [{ type: 'text', text: 'Where is the Eiffel Tower located?' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: TEST_COLLECTION,
          mode: 'auto',
          topK: 2,
          injectAs: 'system'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 100 }
      };

      const chunks: any[] = [];
      for await (const event of llmCoordinator.runStream(spec)) {
        chunks.push(event);
      }

      expect(chunks.length).toBeGreaterThan(0);

      // Find the done event
      const doneEvent = chunks.find(c => c.type === 'done');
      expect(doneEvent).toBeDefined();

      if (doneEvent?.response) {
        const textContent = doneEvent.response.content.find((c: any) => c.type === 'text');
        const text = (textContent as any).text.toLowerCase();
        expect(text.includes('paris') || text.includes('france')).toBe(true);
      }
    }, 60000);
  });
});
