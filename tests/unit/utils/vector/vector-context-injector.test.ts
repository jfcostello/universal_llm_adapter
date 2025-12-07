import { jest } from '@jest/globals';
import { Message, Role, VectorContextConfig, EmbeddingPriorityItem } from '@/core/types.ts';

// Module imports - will exist after implementation
let VectorContextInjector: any;

interface InjectionResult {
  messages: Message[];
  resultsInjected: number;
  query: string;
  retrievedResults: any[];
}

// Mock registry helper
function createMockRegistry(options: {
  embeddingProvider?: any;
  embeddingCompat?: any;
  vectorStore?: any;
  vectorCompat?: any;
} = {}) {
  return {
    getEmbeddingProvider: jest.fn().mockResolvedValue(
      options.embeddingProvider || {
        id: 'test-embeddings',
        kind: 'openrouter',
        endpoint: { urlTemplate: 'http://test', headers: {} },
        model: 'test-model',
        dimensions: 128
      }
    ),
    getEmbeddingCompat: jest.fn().mockResolvedValue(
      options.embeddingCompat || {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'test-model',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(128)
      }
    ),
    getVectorStore: jest.fn().mockResolvedValue(
      options.vectorStore || {
        id: 'test-store',
        kind: 'memory',
        connection: {},
        defaultCollection: 'test'
      }
    ),
    getVectorStoreCompat: jest.fn().mockResolvedValue(
      options.vectorCompat || {
        connect: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.95, payload: { text: 'Relevant content 1' } },
          { id: 'doc2', score: 0.87, payload: { text: 'Relevant content 2' } }
        ])
      }
    )
  };
}

function createMessages(texts: string[]): Message[] {
  return texts.map((text, index) => ({
    role: index % 2 === 0 ? Role.USER : Role.ASSISTANT,
    content: [{ type: 'text' as const, text }]
  }));
}

describe('utils/vector/vector-context-injector', () => {
  beforeAll(async () => {
    try {
      const module = await import('@/utils/vector/vector-context-injector.ts');
      VectorContextInjector = module.VectorContextInjector;
    } catch {
      // Module doesn't exist yet - mock for TDD
      VectorContextInjector = class MockVectorContextInjector {
        constructor(public options: any) {}
        async injectContext(
          messages: Message[],
          config: VectorContextConfig,
          systemPrompt?: string
        ): Promise<InjectionResult> {
          throw new Error('Not implemented');
        }
      };
    }
  });

  describe('injectContext', () => {
    test('extracts query from last user message', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2]],
          model: 'test',
          dimensions: 2
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Result' } }
        ])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['What is machine learning?']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        topK: 5
      };

      const result = await injector.injectContext(messages, config);

      expect(result.query).toBe('What is machine learning?');
      expect(embeddingCompat.embed).toHaveBeenCalledWith(
        'What is machine learning?',
        expect.anything(),
        undefined,
        expect.anything() // logger parameter
      );
    });

    test('returns original messages when no user message found and assistant messages excluded', async () => {
      const registry = createMockRegistry();
      const injector = new VectorContextInjector({ registry });

      const messages: Message[] = [
        { role: Role.ASSISTANT, content: [{ type: 'text', text: 'Hello' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        // Explicitly exclude assistant messages to test empty query scenario
        queryConstruction: {
          includeAssistantMessages: false
        }
      };

      const result = await injector.injectContext(messages, config);

      expect(result.messages).toEqual(messages);
      expect(result.resultsInjected).toBe(0);
      expect(result.query).toBe('');
    });

    test('injects context into system prompt by default', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.95, payload: { text: 'Injected context' } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Tell me about X']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        injectAs: 'system'
      };

      const result = await injector.injectContext(messages, config, 'You are a helpful assistant.');

      // Should have system message at the start
      expect(result.messages[0].role).toBe(Role.SYSTEM);
      expect((result.messages[0].content[0] as any).text).toContain('Injected context');
      expect(result.resultsInjected).toBe(1);
    });

    test('injects context as user_context message', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Context info' } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['First question', 'First answer', 'Second question']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        injectAs: 'user_context'
      };

      const result = await injector.injectContext(messages, config);

      // Context should be injected before the last user message
      const lastUserIndex = result.messages.length - 1;
      expect(result.messages[lastUserIndex].role).toBe(Role.USER);
      // The context message should be before it
      const contextMessage = result.messages[lastUserIndex - 1];
      expect((contextMessage.content[0] as any).text).toContain('Context info');
    });

    test('uses custom inject template', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Result text' } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        injectTemplate: '### Retrieved Documents\n\n{{results}}\n\n### End of Documents'
      };

      const result = await injector.injectContext(messages, config);

      const injectedText = (result.messages[0].content[0] as any).text;
      expect(injectedText).toContain('### Retrieved Documents');
      expect(injectedText).toContain('### End of Documents');
    });

    test('filters results by score threshold', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.95, payload: { text: 'High score' } },
          { id: 'doc2', score: 0.65, payload: { text: 'Low score' } },
          { id: 'doc3', score: 0.85, payload: { text: 'Medium score' } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        scoreThreshold: 0.8
      };

      const result = await injector.injectContext(messages, config);

      expect(result.resultsInjected).toBe(2); // Only doc1 and doc3
      expect(result.retrievedResults).toHaveLength(2);
    });

    test('returns original messages when no results pass threshold', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.5, payload: { text: 'Low score' } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        scoreThreshold: 0.8
      };

      const result = await injector.injectContext(messages, config);

      expect(result.messages).toEqual(messages);
      expect(result.resultsInjected).toBe(0);
    });

    test('uses custom result format', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Content', source: 'file.pdf' } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        resultFormat: '[{{id}}] ({{score}}) {{payload.text}} - from {{payload.source}}'
      };

      const result = await injector.injectContext(messages, config);

      const injectedText = (result.messages[0].content[0] as any).text;
      expect(injectedText).toContain('[doc1]');
      expect(injectedText).toContain('(0.9)');
      expect(injectedText).toContain('Content');
      expect(injectedText).toContain('file.pdf');
    });

    test('uses provided embedding priority', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'custom-model',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ embeddingCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        embeddingPriority: [{ provider: 'custom-embeddings', model: 'custom-model' }]
      };

      await injector.injectContext(messages, config);

      expect(registry.getEmbeddingProvider).toHaveBeenCalledWith('custom-embeddings');
      expect(embeddingCompat.embed).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'custom-model',
        expect.anything() // logger parameter
      );
    });

    test('applies metadata filter to query', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        filter: { category: 'technical', author: 'John' }
      };

      await injector.injectContext(messages, config);

      expect(vectorCompat.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          filter: { category: 'technical', author: 'John' }
        })
      );
    });

    test('queries multiple stores in priority order', async () => {
      const vectorCompat1 = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([]) // No results
      };
      const vectorCompat2 = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'From store 2' } }
        ])
      };

      let callCount = 0;
      const registry = {
        ...createMockRegistry(),
        getVectorStoreCompat: jest.fn().mockImplementation(async () => {
          callCount++;
          return callCount === 1 ? vectorCompat1 : vectorCompat2;
        })
      };

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['store1', 'store2'],
        mode: 'auto'
      };

      const result = await injector.injectContext(messages, config);

      expect(result.resultsInjected).toBe(1);
    });

    test('handles query errors gracefully', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockRejectedValue(new Error('Connection failed'))
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto'
      };

      // Should not throw, but return original messages
      const result = await injector.injectContext(messages, config);

      expect(result.messages).toEqual(messages);
      expect(result.resultsInjected).toBe(0);
    });

    test('handles embedding errors gracefully', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockRejectedValue(new Error('Rate limit')),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ embeddingCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto'
      };

      // Should not throw, but return original messages
      const result = await injector.injectContext(messages, config);

      expect(result.messages).toEqual(messages);
      expect(result.resultsInjected).toBe(0);
    });

    test('uses topK from config', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        topK: 10
      };

      await injector.injectContext(messages, config);

      expect(vectorCompat.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        10, // topK
        expect.anything()
      );
    });

    test('uses default topK of 5 when not specified', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto'
      };

      await injector.injectContext(messages, config);

      expect(vectorCompat.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        5, // default topK
        expect.anything()
      );
    });

    test('extracts query from message with multiple content parts', async () => {
      const registry = createMockRegistry();
      const injector = new VectorContextInjector({ registry });

      const messages: Message[] = [
        {
          role: Role.USER,
          content: [
            { type: 'image', imageUrl: 'http://example.com/image.png' },
            { type: 'text', text: 'What is this?' }
          ]
        }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto'
      };

      const result = await injector.injectContext(messages, config);

      expect(result.query).toBe('What is this?');
    });

    test('skips injection for tool mode', async () => {
      const registry = createMockRegistry();
      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'tool' // Tool mode - no auto-injection
      };

      const result = await injector.injectContext(messages, config);

      // Should return messages unchanged
      expect(result.messages).toEqual(messages);
      expect(result.resultsInjected).toBe(0);
    });

    test('performs injection for both mode', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Result' } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'both' // Both mode - should still inject
      };

      const result = await injector.injectContext(messages, config);

      expect(result.resultsInjected).toBe(1);
    });
  });

  describe('query extraction edge cases', () => {
    test('uses most recent user message when multiple exist', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({ vectors: [[0.1]], model: 'test', dimensions: 1 }),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ embeddingCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages([
        'First question',
        'First answer',
        'Second question',
        'Second answer',
        'Third question' // Most recent
      ]);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto'
      };

      const result = await injector.injectContext(messages, config);

      expect(result.query).toBe('Third question');
      expect(embeddingCompat.embed).toHaveBeenCalledWith(
        'Third question',
        expect.anything(),
        undefined,
        expect.anything() // logger parameter
      );
    });

    test('handles empty text in user message', async () => {
      const registry = createMockRegistry();
      const injector = new VectorContextInjector({ registry });

      const messages: Message[] = [
        { role: Role.USER, content: [{ type: 'text', text: '' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto'
      };

      const result = await injector.injectContext(messages, config);

      expect(result.messages).toEqual(messages);
      expect(result.query).toBe('');
    });

    test('handles user message with no text content', async () => {
      const registry = createMockRegistry();
      const injector = new VectorContextInjector({ registry });

      const messages: Message[] = [
        { role: Role.USER, content: [{ type: 'image', imageUrl: 'http://example.com/img.png' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto'
      };

      const result = await injector.injectContext(messages, config);

      expect(result.messages).toEqual(messages);
      expect(result.query).toBe('');
    });
  });

  describe('query construction settings', () => {
    test('uses overrideEmbeddingQuery when provided', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2]],
          model: 'test',
          dimensions: 2
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Result' } }
        ])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['What is the weather today?']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        overrideEmbeddingQuery: 'custom search terms for embedding'
      };

      const result = await injector.injectContext(messages, config);

      // Should use override, not the user message
      expect(result.query).toBe('custom search terms for embedding');
      expect(embeddingCompat.embed).toHaveBeenCalledWith(
        'custom search terms for embedding',
        expect.anything(),
        undefined,
        expect.anything()
      );
    });

    test('includes multiple messages when messagesToInclude > 1', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages([
        'First question',
        'First answer',
        'Second question',
        'Second answer',
        'Third question'
      ]);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        queryConstruction: {
          messagesToInclude: 3,
          includeAssistantMessages: true,
          includeSystemPrompt: 'never'
        }
      };

      const result = await injector.injectContext(messages, config);

      // Last 3 messages: "Second question", "Second answer", "Third question"
      expect(result.query).toContain('Second question');
      expect(result.query).toContain('Second answer');
      expect(result.query).toContain('Third question');
      expect(result.query).not.toContain('First question');
    });

    test('includes all messages when messagesToInclude is 0', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages([
        'First question',
        'First answer',
        'Second question'
      ]);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        queryConstruction: {
          messagesToInclude: 0, // 0 means all
          includeAssistantMessages: true,
          includeSystemPrompt: 'never'
        }
      };

      const result = await injector.injectContext(messages, config);

      // All messages should be included
      expect(result.query).toContain('First question');
      expect(result.query).toContain('First answer');
      expect(result.query).toContain('Second question');
    });

    test('excludes assistant messages when includeAssistantMessages is false', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages([
        'First question',
        'First answer',
        'Second question'
      ]);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        queryConstruction: {
          messagesToInclude: 0, // all
          includeAssistantMessages: false,
          includeSystemPrompt: 'never'
        }
      };

      const result = await injector.injectContext(messages, config);

      // Only user messages should be included
      expect(result.query).toContain('First question');
      expect(result.query).not.toContain('First answer');
      expect(result.query).toContain('Second question');
    });

    test('includes system prompt when includeSystemPrompt is always', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages: Message[] = [
        { role: Role.SYSTEM, content: [{ type: 'text', text: 'You are a helpful assistant' }] },
        { role: Role.USER, content: [{ type: 'text', text: 'User question' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        queryConstruction: {
          messagesToInclude: 1, // only last message
          includeAssistantMessages: true,
          includeSystemPrompt: 'always'
        }
      };

      const result = await injector.injectContext(messages, config);

      // System prompt should be included even though messagesToInclude is 1
      expect(result.query).toContain('You are a helpful assistant');
      expect(result.query).toContain('User question');
    });

    test('excludes system prompt when includeSystemPrompt is never', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages: Message[] = [
        { role: Role.SYSTEM, content: [{ type: 'text', text: 'You are a helpful assistant' }] },
        { role: Role.USER, content: [{ type: 'text', text: 'User question' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        queryConstruction: {
          messagesToInclude: 0, // all messages
          includeAssistantMessages: true,
          includeSystemPrompt: 'never'
        }
      };

      const result = await injector.injectContext(messages, config);

      // System prompt should NOT be included
      expect(result.query).not.toContain('You are a helpful assistant');
      expect(result.query).toContain('User question');
    });

    test('includes system prompt if-in-range when messagesToInclude covers it', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages: Message[] = [
        { role: Role.SYSTEM, content: [{ type: 'text', text: 'System instructions' }] },
        { role: Role.USER, content: [{ type: 'text', text: 'Only user message' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        queryConstruction: {
          messagesToInclude: 5, // More than total messages, so system is in range
          includeAssistantMessages: true,
          includeSystemPrompt: 'if-in-range'
        }
      };

      const result = await injector.injectContext(messages, config);

      // System prompt should be included because total messages (2) <= messagesToInclude (5)
      expect(result.query).toContain('System instructions');
      expect(result.query).toContain('Only user message');
    });

    test('excludes system prompt if-in-range when messagesToInclude does not cover it', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages: Message[] = [
        { role: Role.SYSTEM, content: [{ type: 'text', text: 'System instructions' }] },
        { role: Role.USER, content: [{ type: 'text', text: 'First question' }] },
        { role: Role.ASSISTANT, content: [{ type: 'text', text: 'First answer' }] },
        { role: Role.USER, content: [{ type: 'text', text: 'Second question' }] },
        { role: Role.ASSISTANT, content: [{ type: 'text', text: 'Second answer' }] },
        { role: Role.USER, content: [{ type: 'text', text: 'Third question' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        queryConstruction: {
          messagesToInclude: 2, // Only last 2 messages
          includeAssistantMessages: true,
          includeSystemPrompt: 'if-in-range'
        }
      };

      const result = await injector.injectContext(messages, config);

      // System prompt should NOT be included because total messages (6) > messagesToInclude (2)
      expect(result.query).not.toContain('System instructions');
      expect(result.query).toContain('Second answer');
      expect(result.query).toContain('Third question');
    });

    test('uses default queryConstruction settings when not specified', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages([
        'First question',
        'First answer',
        'Second question'
      ]);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto'
        // No queryConstruction - should use defaults (messagesToInclude: 1)
      };

      const result = await injector.injectContext(messages, config);

      // Default is messagesToInclude: 1, so only last user message
      expect(result.query).toBe('Second question');
      expect(result.query).not.toContain('First');
    });

    test('handles empty overrideEmbeddingQuery by falling back to normal extraction', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['User question']);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        overrideEmbeddingQuery: '   ' // whitespace only
      };

      const result = await injector.injectContext(messages, config);

      // Should fall back to normal extraction since override is empty/whitespace
      expect(result.query).toBe('User question');
    });

    test('combines user and assistant messages with newlines', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([])
      };
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages([
        'Question one',
        'Answer one',
        'Question two'
      ]);

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        queryConstruction: {
          messagesToInclude: 3,
          includeAssistantMessages: true,
          includeSystemPrompt: 'never'
        }
      };

      const result = await injector.injectContext(messages, config);

      // Messages should be joined with newlines
      expect(result.query).toBe('Question one\nAnswer one\nQuestion two');
    });
  });

  describe('injection position edge cases', () => {
    test('appends to existing system message', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Context result' } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages: Message[] = [
        { role: Role.SYSTEM, content: [{ type: 'text', text: 'Existing system prompt' }] },
        { role: Role.USER, content: [{ type: 'text', text: 'Query' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        injectAs: 'system'
      };

      const result = await injector.injectContext(messages, config);

      // Should append to existing system message, not create new one
      expect(result.messages.length).toBe(2);
      expect(result.messages[0].role).toBe(Role.SYSTEM);
      const systemText = (result.messages[0].content[0] as any).text;
      expect(systemText).toContain('Existing system prompt');
      expect(systemText).toContain('Context result');
    });

    test('handles empty query gracefully when assistant messages excluded and no user message exists', async () => {
      // This tests the scenario where no extractable content exists.
      // With includeAssistantMessages: false and no user messages, query extraction
      // returns empty and we verify the code handles this gracefully.
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Context' } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages: Message[] = [
        // Only assistant message, no user message
        { role: Role.ASSISTANT, content: [{ type: 'text', text: 'Hello!' }] }
      ];

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto',
        injectAs: 'user_context',
        // Explicitly exclude assistant messages to test empty query scenario
        queryConstruction: {
          includeAssistantMessages: false
        }
      };

      const result = await injector.injectContext(messages, config);

      // Without user messages and with assistant messages excluded, query extraction returns empty
      expect(result.resultsInjected).toBe(0);
      expect(result.query).toBe('');
    });

    test('processes multiple queries successfully', async () => {
      const queryFn = jest.fn().mockResolvedValue([
        { id: 'doc1', score: 0.9, payload: { text: 'Result' } }
      ]);
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: queryFn
      };

      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });

      const config: VectorContextConfig = {
        stores: ['test-store'],
        mode: 'auto'
      };

      // First call
      const result1 = await injector.injectContext(
        [{ role: Role.USER, content: [{ type: 'text', text: 'First query' }] }],
        config
      );

      // Second call
      const result2 = await injector.injectContext(
        [{ role: Role.USER, content: [{ type: 'text', text: 'Second query' }] }],
        config
      );

      // Both should have successfully injected results
      expect(result1.resultsInjected).toBe(1);
      expect(result2.resultsInjected).toBe(1);
      // Query should be called for each injection
      expect(queryFn).toHaveBeenCalledTimes(2);
    });

    test('uses default collection when not specified in config', async () => {
      const queryFn = jest.fn().mockResolvedValue([]);
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: queryFn
      };

      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({ vectors: [[0.1]], model: 'test', dimensions: 1 }),
        getDimensions: jest.fn()
      };

      // Store config without defaultCollection
      const registry = createMockRegistry({
        vectorStore: { id: 'test-store', kind: 'memory' }, // No defaultCollection
        vectorCompat,
        embeddingCompat
      });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      await injector.injectContext(messages, {
        stores: ['test-store'],
        mode: 'auto'
      });

      // Should use 'default' as collection
      expect(queryFn).toHaveBeenCalledWith(
        'default',
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });

    test('handles non-Error throws in query', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockRejectedValue('string error') // Non-Error throw
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const result = await injector.injectContext(messages, {
        stores: ['test-store'],
        mode: 'auto'
      });

      // Should handle gracefully, no results injected
      expect(result.resultsInjected).toBe(0);
    });

    test('handles result with null payload', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: null } // payload is null
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const result = await injector.injectContext(messages, {
        stores: ['test-store'],
        mode: 'auto'
      });

      // Should handle null payload gracefully
      expect(result.resultsInjected).toBe(1);
    });

    test('handles appending to system message with undefined text', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Result' } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      // Create messages with system message that has content without text property
      // This hits the ?? '' branch at line 250
      const messages: Message[] = [
        { role: Role.SYSTEM, content: [{ type: 'text' }] } as any, // No text property
        { role: Role.USER, content: [{ type: 'text', text: 'Query' }] }
      ];

      const result = await injector.injectContext(messages, {
        stores: ['test-store'],
        mode: 'auto',
        injectAs: 'system'
      });

      // Should handle empty system text gracefully
      expect(result.resultsInjected).toBe(1);
    });

    test('interpolates nested key that becomes null mid-chain', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { level1: null } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const result = await injector.injectContext(messages, {
        stores: ['test-store'],
        mode: 'auto',
        resultFormat: '{{payload.level1.level2}}' // level2 lookup on null
      });

      // Should return empty string for null in chain
      expect(result.resultsInjected).toBe(1);
    });

    test('interpolates key where final value is null', async () => {
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: null } }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      const result = await injector.injectContext(messages, {
        stores: ['test-store'],
        mode: 'auto',
        resultFormat: '{{payload.text}}' // text is null
      });

      // Should return empty string for null value
      expect(result.resultsInjected).toBe(1);
    });

    test('calls setLogger on vector compat when available', async () => {
      const setLoggerMock = jest.fn();
      const vectorCompat = {
        connect: jest.fn(),
        close: jest.fn(),
        query: jest.fn().mockResolvedValue([
          { id: 'doc1', score: 0.9, payload: { text: 'Result' } }
        ]),
        setLogger: setLoggerMock
      };
      const registry = createMockRegistry({ vectorCompat });

      const injector = new VectorContextInjector({ registry });
      const messages = createMessages(['Query']);

      await injector.injectContext(messages, {
        stores: ['test-store'],
        mode: 'auto'
      });

      // setLogger should be called on the compat
      expect(setLoggerMock).toHaveBeenCalled();
    });
  });
});
