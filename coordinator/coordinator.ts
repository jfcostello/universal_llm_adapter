import {
  LLMCallSpec,
  LLMResponse,
  LLMStreamEvent,
  Message,
  ReasoningData,
  Role,
  TextContent,
  UnifiedTool,
  StreamEventType,
  ToolCallEventType,
  MCPServerConfig,
  DocumentContent
} from '../core/types.js';
import { PluginRegistry } from '../core/registry.js';
import { LLMManager } from '../managers/llm-manager.js';
import { getLogger, AdapterLogger, closeLogger as resetLogger } from '../core/logging.js';
import { pruneToolResults, pruneReasoning } from '../utils/context/context-manager.js';
import { RuntimeSettings } from '../core/types.js';
import { partitionSettings, mergeProviderSettings } from '../utils/settings/settings-partitioner.js';
import { prepareMessages, appendAssistantToolCalls, appendToolResult } from '../utils/messages/message-utils.js';
import { collectTools } from '../utils/tools/tool-discovery.js';
import { sanitizeToolName, sanitizeToolChoice } from '../utils/tools/tool-names.js';
import { processDocumentContent } from '../utils/documents/document-loader.js';
import { runToolLoop } from '../utils/tools/tool-loop.js';
import { ProviderExecutionError } from '../core/errors.js';
import { withRetries } from '../utils/retry/priority-handler.js';
import { ToolCoordinator } from '../utils/tools/tool-coordinator.js';

// Type-only imports for lazy loading
import type { MCPManager } from '../managers/mcp-manager.js';
import type { VectorStoreManager } from '../managers/vector-store-manager.js';
import type { VectorContextInjector } from '../utils/vector/vector-context-injector.js';

export class LLMCoordinator {
  private llmManager: LLMManager;
  private mcpManager?: MCPManager;
  private vectorManager?: VectorStoreManager;
  private vectorContextInjector?: VectorContextInjector;
  private toolCoordinator: ToolCoordinator;
  private logger: AdapterLogger;
  private toolCoordinatorInitialized = false;

  constructor(
    private registry: PluginRegistry,
    options?: {
      vectorManager?: VectorStoreManager;
    }
  ) {
    this.llmManager = new LLMManager(registry);
    this.vectorManager = options?.vectorManager;
    this.logger = getLogger();

    // Initialize ToolCoordinator with empty routes - will be populated lazily
    // This ensures tests can spy on it before it's fully initialized
    this.toolCoordinator = new ToolCoordinator([], undefined);
  }

  private async ensureToolCoordinator(spec: LLMCallSpec): Promise<ToolCoordinator> {
    if (this.toolCoordinatorInitialized) {
      // Update vector context for new spec (may have different locks)
      this.toolCoordinator.setVectorContext(spec.vectorContext, this.registry);
      return this.toolCoordinator;
    }

    // Lazy-load MCPManager if spec requests MCP servers
    if (spec.mcpServers && spec.mcpServers.length > 0) {
      const mcpServers = await this.registry.getMCPServers(spec.mcpServers);
      if (mcpServers.length > 0) {
        const { MCPManager } = await import('../managers/mcp-manager.js');
        this.mcpManager = new MCPManager(mcpServers);
      }
    }

    const processRoutes = await this.registry.getProcessRoutes();
    this.toolCoordinator = new ToolCoordinator(
      processRoutes,
      this.mcpManager?.getPool(),
      {
        vectorContext: spec.vectorContext,
        registry: this.registry
      }
    );

    this.toolCoordinatorInitialized = true;
    return this.toolCoordinator;
  }

  private async applyRuntimeEnvironment(runtime: RuntimeSettings): Promise<void> {
    if (!runtime.batchId) {
      return;
    }

    const normalized = String(runtime.batchId);
    if (process.env.LLM_ADAPTER_BATCH_ID === normalized) {
      return;
    }

    process.env.LLM_ADAPTER_BATCH_ID = normalized;
    await resetLogger();
    this.logger = getLogger();
  }

  async run(spec: LLMCallSpec): Promise<LLMResponse> {
    const { runtime, provider, providerExtras } = partitionSettings(spec.settings);
    await this.applyRuntimeEnvironment(runtime);

    const executionSpec: LLMCallSpec = {
      ...spec,
      settings: provider
    };

    let messages = this.prepareMessages(executionSpec);

    // Inject vector context if configured for auto or both mode
    if (this.shouldInjectVectorContext(spec)) {
      const injector = await this.ensureVectorContextInjector();
      const injectionResult = await injector.injectContext(
        messages,
        spec.vectorContext!,
        spec.systemPrompt
      );
      messages = injectionResult.messages;
    }

    // Ensure tool coordinator is initialized if needed
    const needsTools = (spec.tools && spec.tools.length > 0) ||
                      (spec.functionToolNames && spec.functionToolNames.length > 0) ||
                      (spec.mcpServers && spec.mcpServers.length > 0) ||
                      (spec.vectorPriority && spec.vectorPriority.length > 0) ||
                      this.shouldCreateVectorTool(spec);

    if (needsTools) {
      await this.ensureToolCoordinator(executionSpec);
    }

    const [tools, mcpServers, toolNameMap, vectorSearchAliasMap] = await this.collectTools(executionSpec);

    // Update vector context with alias map after collectTools generates it
    if (needsTools && vectorSearchAliasMap) {
      this.toolCoordinator.setVectorContext(executionSpec.vectorContext, this.registry, vectorSearchAliasMap);
    }

    // Sanitize toolChoice to match sanitized tool names
    executionSpec.toolChoice = sanitizeToolChoice(executionSpec.toolChoice);

    const runContext = {
      tools: tools.map(t => t.name),
      mcpServers,
      toolNameMap
    };

    const runLogger = this.logger.withCorrelation(spec.metadata?.correlationId as string);

    // Build retry sequence
    const sequence = spec.llmPriority.map(item => {
      // Merge per-provider settings with global settings
      const mergedSettings = mergeProviderSettings(executionSpec.settings, item.settings);

      return {
        provider: item.provider,
        model: item.model,
        fn: async () => {
          const providerManifest = await this.registry.getProvider(item.provider);

          runLogger.info('Calling provider endpoint', {
            provider: providerManifest.id,
            model: item.model,
            tools: runContext.tools,
            mcpServers: runContext.mcpServers,
            hasPerProviderSettings: !!item.settings
          });

          let response = await this.llmManager.callProvider(
            providerManifest,
            item.model,
            mergedSettings,
            messages,
            tools,
            executionSpec.toolChoice,
            providerExtras,
            runLogger,
            runContext
          );

          this.ensureValidAssistantResponse(response, providerManifest.id);

          runLogger.info('Provider response processed', {
            provider: providerManifest.id,
            model: item.model,
            finishReason: response.finishReason,
            toolCalls: response.toolCalls?.map(c => c.name) || [],
            usage: response.usage ? {
              promptTokens: response.usage.promptTokens,
              completionTokens: response.usage.completionTokens,
              reasoningTokens: response.usage.reasoningTokens,
              cost: response.usage.cost,
              cachedTokens: response.usage.cachedTokens,
              audioTokens: response.usage.audioTokens
            } : undefined
          });

          // Create spec with merged settings for tool loop
          const providerSpec: LLMCallSpec = {
            ...executionSpec,
            settings: mergedSettings
          };

          response = await this.handleTools(
            providerSpec,
            runtime,
            providerExtras,
            providerManifest,
            item.model,
            messages,
            tools,
            response,
            runLogger,
            runContext,
            toolNameMap
          );

          this.ensureValidAssistantResponse(response, providerManifest.id);

          return response;
        }
      };
    });
    
    if (!sequence.length) {
      throw new Error('LLMCallSpec.llmPriority must include at least one provider');
    }
    
    const { retry } = await import('../core/defaults.js').then(m => ({ retry: m.getDefaults().retry }));
    const retryPolicy = {
      maxAttempts: retry.maxAttempts,
      baseDelayMs: retry.baseDelayMs,
      multiplier: retry.multiplier,
      rateLimitDelays: executionSpec.rateLimitRetryDelays || retry.rateLimitDelays
    };
    
    const response = await withRetries<LLMResponse>(sequence, retryPolicy, runLogger);
    this.ensureValidAssistantResponse(response, response.provider);
    return response;
  }

  async *runStream(spec: LLMCallSpec): AsyncGenerator<LLMStreamEvent> {
    if (!spec.llmPriority.length) {
      throw new Error('LLMCallSpec.llmPriority must include at least one provider');
    }

    const { runtime, provider, providerExtras } = partitionSettings(spec.settings);
    await this.applyRuntimeEnvironment(runtime);

    const executionSpec: LLMCallSpec = {
      ...spec,
      settings: provider
    };

    const providerPref = executionSpec.llmPriority[0];

    // Merge per-provider settings for streaming (only first provider is used)
    const mergedSettings = mergeProviderSettings(executionSpec.settings, providerPref.settings);
    const streamExecutionSpec: LLMCallSpec = {
      ...executionSpec,
      settings: mergedSettings
    };

    const providerManifest = await this.registry.getProvider(providerPref.provider);
    let messages = this.prepareMessages(streamExecutionSpec);

    // Inject vector context if configured for auto or both mode
    if (this.shouldInjectVectorContext(spec)) {
      const injector = await this.ensureVectorContextInjector();
      const injectionResult = await injector.injectContext(
        messages,
        spec.vectorContext!,
        spec.systemPrompt
      );
      messages = injectionResult.messages;
    }

    // Ensure tool coordinator is initialized if needed
    const needsTools = (spec.tools && spec.tools.length > 0) ||
                      (spec.functionToolNames && spec.functionToolNames.length > 0) ||
                      (spec.mcpServers && spec.mcpServers.length > 0) ||
                      (spec.vectorPriority && spec.vectorPriority.length > 0) ||
                      this.shouldCreateVectorTool(spec);

    if (needsTools) {
      await this.ensureToolCoordinator(executionSpec);
    }

    const [tools, mcpServers, toolNameMap, vectorSearchAliasMap] = await this.collectTools(executionSpec);

    // Update vector context with alias map after collectTools generates it
    if (needsTools && vectorSearchAliasMap) {
      this.toolCoordinator.setVectorContext(executionSpec.vectorContext, this.registry, vectorSearchAliasMap);
    }

    // Sanitize toolChoice to match sanitized tool names
    streamExecutionSpec.toolChoice = sanitizeToolChoice(streamExecutionSpec.toolChoice);

    const runLogger = this.logger.withCorrelation(spec.metadata?.correlationId as string);
    runLogger.info('Streaming call started', {
      provider: providerManifest.id,
      model: providerPref.model,
      tools: tools.map(t => t.name),
      mcpServers
    });

    // Delegate streaming to StreamCoordinator
    const streamCoordinator = new (await import('./stream-coordinator.js')).StreamCoordinator(
      this.registry,
      this.llmManager,
      this.toolCoordinator
    );

    const context = {
      provider: providerManifest.id,
      model: providerPref.model,
      tools,
      mcpServers,
      toolNameMap: new Map<string, string>(Object.entries(toolNameMap)),
      logger: runLogger
    };

    yield* streamCoordinator.coordinateStream(
      streamExecutionSpec,
      messages,
      tools,
      context,
      { requireFinishToExecute: true }
    );
  }

  private async *executeToolsAndContinueStreaming(
    spec: LLMCallSpec,
    runtime: RuntimeSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolCalls: any[],
    providerManifest: any,
    model: string,
    toolNameMap: Record<string, string>,
    providerExtras: Record<string, any>,
    logger: AdapterLogger,
    toolChoice: any,
    reasoning?: ReasoningData
  ): AsyncGenerator<LLMStreamEvent, string | undefined> {
    logger.info('executeToolsAndContinueStreaming started', { toolCallCount: toolCalls.length });

    // Extract preservation settings (lazy load defaults)
    const { tools: toolDefaults } = await import('../core/defaults.js').then(m => ({ tools: m.getDefaults().tools }));
    const preserveToolResults = runtime.preserveToolResults ?? toolDefaults.preserveResults;
    const preserveReasoning = runtime.preserveReasoning ?? toolDefaults.preserveReasoning;

    // Add assistant message with tool calls (use sanitized names for API compatibility)
    appendAssistantToolCalls(
      messages,
      toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments
      })),
      { sanitizeName: sanitizeToolName, content: [], reasoning }
    );

    // Execute each tool and add results to messages
    for (const toolCall of toolCalls) {
      logger.info('Invoking tool', {
        toolName: toolCall.name,
        callId: toolCall.id
      });

      try {
        logger.info('About to invoke tool', { toolName: toolCall.name });
        const result = await this.toolCoordinator.routeAndInvoke(
          toolCall.name,
          toolCall.id,
          toolCall.arguments,
          {
            provider: providerManifest.id,
            model,
            metadata: spec.metadata,
            logger
          }
        );
        logger.info('Tool invoked successfully', { toolName: toolCall.name, result });

        appendToolResult(messages, {
          toolName: toolCall.name,
          callId: toolCall.id,
          result,
          resultText: typeof result === 'string' ? result : JSON.stringify(result)
        });
        logger.info('Added tool result to messages', { toolName: toolCall.name });
      } catch (error) {
        logger.error('Tool execution failed', {
          toolName: toolCall.name,
          callId: toolCall.id,
          error: error instanceof Error ? error.message : String(error)
        });

        // Add error as tool result
        const errorResult = {
          error: 'tool_execution_failed',
          message: error instanceof Error ? error.message : String(error)
        };

        appendToolResult(messages, {
          toolName: toolCall.name,
          callId: toolCall.id,
          result: errorResult,
          resultText: JSON.stringify(errorResult)
        });
      }
    }

    // Continue streaming with updated messages (keep tools and toolChoice like non-streaming version)
    logger.info('Starting follow-up stream', {
      messagesCount: messages.length,
      lastMessage: messages[messages.length - 1],
      toolsCount: tools.length,
      toolChoice
    });

    // Prune old tool results and reasoning before follow-up stream
    pruneToolResults(messages, preserveToolResults);
    pruneReasoning(messages, preserveReasoning);

    let followUpStream;
    try {
      followUpStream = this.llmManager.streamProvider(
        providerManifest,
        model,
        spec.settings,
        messages,
        tools,  // Keep tools available for potential multi-turn tool use
        toolChoice,
        providerExtras,
        logger
      );
      logger.info('Follow-up stream created successfully');
    } catch (error) {
      logger.error('Error creating follow-up stream', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    let followUpContent = '';
    let chunkCount = 0;
    logger.info('About to iterate follow-up stream');

    try {
      for await (const chunk of followUpStream) {
        chunkCount++;
        const compat = await this.registry.getCompatModule(providerManifest.compat);
        const parsed = compat.parseStreamChunk(chunk);

        logger.info('Follow-up chunk received', {
          chunkNumber: chunkCount,
          hasText: !!parsed.text,
          text: parsed.text,
          chunk: JSON.stringify(chunk).substring(0, 200)
        });

        if (parsed.text) {
          followUpContent += parsed.text;
          yield {
            type: StreamEventType.DELTA,
            content: parsed.text
          };
        }
      }
    } catch (error) {
      logger.error('Error iterating follow-up stream', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    logger.info('Follow-up stream loop ended', { chunkCount, followUpContent });

    logger.info('Follow-up stream complete', { followUpContent });
    return followUpContent;
  }

  private handleTools(
    spec: LLMCallSpec,
    runtime: RuntimeSettings,
    providerExtras: Record<string, any>,
    providerManifest: any,
    model: string,
    messages: Message[],
    tools: UnifiedTool[],
    response: LLMResponse,
    logger: AdapterLogger,
    runContext: any,
    toolNameMap: Record<string, string>
  ): Promise<LLMResponse> {
    return runToolLoop({
      mode: 'nonstream',
      llmManager: this.llmManager,
      registry: this.registry,
      messages,
      tools,
      toolChoice: spec.toolChoice,
      providerManifest,
      model,
      runtime,
      providerSettings: spec.settings,
      providerExtras,
      logger,
      runContext,
      toolNameMap,
      metadata: spec.metadata,
      initialResponse: response,
      invokeTool: async (toolName, call, context) => {
        return this.toolCoordinator.routeAndInvoke(
          toolName,
          call.id,
          call.arguments,
          {
            provider: context.provider,
            model: context.model,
            metadata: context.metadata,
            logger: context.logger,
            callProgress: context.callProgress
          }
        );
      }
    });
  }


  private parseMaxToolIterations(value: unknown): number {
    if (value === null || value === undefined) return 10;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 10;
    }
    const parsed = parseInt(String(value), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 10;
  }

  private normalizeFlag(value: any, defaultValue: boolean): boolean {
    if (value === null || value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Boolean(value);
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
      return defaultValue;
    }
    return Boolean(value);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.toolCoordinator.close(),
      this.mcpManager?.close()
    ]);
  }

  private prepareMessages(spec: LLMCallSpec): Message[] {
    const messages = prepareMessages(spec);

    // Process document content: convert filepath sources to base64
    return messages.map(msg => ({
      ...msg,
      content: msg.content.map(part => {
        if (part.type === 'document') {
          return processDocumentContent(part as DocumentContent);
        }
        return part;
      })
    }));
  }

  private async collectTools(spec: LLMCallSpec): Promise<[UnifiedTool[], string[], Record<string, string>, Record<string, string> | undefined]> {
    const result = await collectTools({
      spec,
      registry: this.registry,
      mcpManager: this.mcpManager,
      vectorManager: this.vectorManager
    });
    return [result.tools, result.mcpServers, result.toolNameMap, result.vectorSearchAliasMap];
  }

  private sanitizeToolName(name: string): string {
    return sanitizeToolName(name);
  }

  private ensureValidAssistantResponse(response: LLMResponse, providerId: string | undefined): void {
    const targetProvider = providerId ?? 'unknown-provider';
    if (!response) {
      throw new ProviderExecutionError(targetProvider, 'Malformed LLM response: response was undefined');
    }

    if (response.role !== Role.ASSISTANT) {
      throw new ProviderExecutionError(targetProvider, 'Malformed LLM response: missing assistant role');
    }

    if (!Array.isArray(response.content)) {
      throw new ProviderExecutionError(targetProvider, 'Malformed LLM response: content must be an array');
    }
  }

  /**
   * Check if vector context should be auto-injected before the LLM call.
   * Returns true for 'auto' or 'both' modes.
   */
  private shouldInjectVectorContext(spec: LLMCallSpec): boolean {
    const mode = spec.vectorContext?.mode;
    return mode === 'auto' || mode === 'both';
  }

  /**
   * Check if a vector_search tool should be created for the LLM.
   * Returns true for 'tool' or 'both' modes.
   */
  private shouldCreateVectorTool(spec: LLMCallSpec): boolean {
    const mode = spec.vectorContext?.mode;
    return mode === 'tool' || mode === 'both';
  }

  /**
   * Lazily initialize the VectorContextInjector.
   */
  private async ensureVectorContextInjector(): Promise<VectorContextInjector> {
    if (!this.vectorContextInjector) {
      // Lazy-load VectorStoreManager if not already provided
      if (!this.vectorManager) {
        const { VectorStoreManager } = await import('../managers/vector-store-manager.js');
        this.vectorManager = new VectorStoreManager(
          new Map(),  // configs - will be loaded from registry
          new Map(),  // adapters - will be created via compat
          undefined,  // embedder - not needed, we use EmbeddingManager directly
          this.registry
        );
      }

      // Lazy-load EmbeddingManager with logger for embedding request/response logging
      const { EmbeddingManager } = await import('../managers/embedding-manager.js');
      const { getEmbeddingLogger } = await import('../core/logging.js');
      const embeddingManager = new EmbeddingManager(this.registry, getEmbeddingLogger());

      // Lazy-load VectorContextInjector
      const { VectorContextInjector } = await import('../utils/vector/vector-context-injector.js');
      this.vectorContextInjector = new VectorContextInjector({
        registry: this.registry,
        embeddingManager,
        vectorManager: this.vectorManager
      });
    }
    return this.vectorContextInjector;
  }
}
