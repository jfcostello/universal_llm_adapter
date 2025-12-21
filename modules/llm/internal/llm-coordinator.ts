import type {
  LLMCallSpec,
  LLMResponse,
  LLMStreamEvent,
  Message,
  ReasoningData,
  UnifiedTool,
  DocumentContent,
  LLMCallSettings,
  RuntimeSettings,
  VectorContextConfig,
  PluginRegistry,
  AdapterLogger,
  LoggingDeps
} from '../../kernel/index.js';
import {
  Role,
  StreamEventType,
  sanitizeToolName,
  ProviderExecutionError,
  getDefaults,
  resolveLoggingDeps
} from '../../kernel/index.js';
import { LLMManager } from './llm-manager.js';
import { normalizeFlag } from '../../shared/index.js';
import { pruneToolResults, pruneReasoning } from '../../context/index.js';
import { partitionSettings, mergeProviderSettings } from '../../settings/index.js';
import { prepareMessages, appendAssistantToolCalls, appendToolResult } from '../../messages/index.js';
import { processDocumentContent } from '../../documents/index.js';
import { withRetries } from '../../retry/index.js';

// Type-only imports for optional modules (must not evaluate at runtime unless needed)
import type { MCPManager } from '../../mcp/index.js';
import type { VectorStoreManager, VectorContextInjector } from '../../vector/index.js';

export class LLMCoordinator {
  private llmManager: LLMManager;
  private mcpManager?: MCPManager;
  private vectorManager?: VectorStoreManager;
  private vectorContextInjector?: VectorContextInjector;
  private toolCoordinator: any;
  private toolCoordinatorImpl?: any;
  private logging: LoggingDeps;
  private logger: AdapterLogger;
  private toolCoordinatorInitialized = false;
  private activeToolSpec?: LLMCallSpec;
  private pendingVectorContext?: {
    config: VectorContextConfig | undefined;
    aliasMap?: Record<string, string>;
  };

  constructor(
    private registry: PluginRegistry,
    options?: {
      vectorManager?: VectorStoreManager;
      logging?: Partial<LoggingDeps>;
    }
  ) {
    this.llmManager = new LLMManager(registry);
    this.vectorManager = options?.vectorManager;
    this.logging = resolveLoggingDeps(options?.logging);
    this.logger = this.logging.getLogger();

    // Stable proxy so tests can spy on methods without being broken by lazy initialization.
    // The real implementation is stored in `toolCoordinatorImpl` and populated on-demand.
    this.toolCoordinator = {
      __isToolCoordinatorProxy: true,
      setVectorContext: (config: VectorContextConfig | undefined, _registry?: PluginRegistry, aliasMap?: Record<string, string>) => {
        this.pendingVectorContext = { config, aliasMap };
        this.toolCoordinatorImpl?.setVectorContext?.(config, this.registry, aliasMap);
      },
      routeAndInvoke: async (toolName: string, callId: string, args: any, context: any) => {
        if (!this.toolCoordinatorImpl) {
          if (!this.activeToolSpec) {
            throw new Error('ToolCoordinator not initialized (no active spec)');
          }
          await this.ensureToolCoordinator(this.activeToolSpec);
        }
        return this.toolCoordinatorImpl.routeAndInvoke(toolName, callId, args, context);
      },
      close: async () => {
        await this.toolCoordinatorImpl?.close?.();
      }
    };
  }

  private async ensureToolCoordinator(spec: LLMCallSpec): Promise<any> {
    this.activeToolSpec = spec;

    if (this.toolCoordinatorInitialized) {
      // Update vector context for new spec (may have different locks)
      const config = this.pendingVectorContext?.config ?? spec.vectorContext;
      const aliasMap = this.pendingVectorContext?.aliasMap;
      this.toolCoordinatorImpl?.setVectorContext?.(config, this.registry, aliasMap);
      return this.toolCoordinator;
    }

    // Lazy-load MCPManager if spec requests MCP servers
    if (spec.mcpServers && spec.mcpServers.length > 0) {
      const mcpServers = await this.registry.getMCPServers(spec.mcpServers);
      if (mcpServers.length > 0) {
        const { MCPManager } = await import('../../mcp/index.js');
        this.mcpManager = new MCPManager(mcpServers, { logging: this.logging });
      }
    }

    const processRoutes = await this.registry.getProcessRoutes();
    const { ToolCoordinator } = await import('../../tools/index.js');
    this.toolCoordinatorImpl = new ToolCoordinator(
      processRoutes,
      this.mcpManager?.getPool(),
      {
        vectorContext: this.pendingVectorContext?.config ?? spec.vectorContext,
        registry: this.registry,
        vectorSearchAliasMap: this.pendingVectorContext?.aliasMap
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
    await this.logging.closeLogger();
    this.logger = this.logging.getLogger();
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

    // Tools are optional; avoid importing tool code unless actually needed.
    const needsTools = (spec.tools && spec.tools.length > 0) ||
                      (spec.functionToolNames && spec.functionToolNames.length > 0) ||
                      (spec.mcpServers && spec.mcpServers.length > 0) ||
                      (spec.vectorPriority && spec.vectorPriority.length > 0) ||
                      this.shouldCreateVectorTool(spec) ||
                      (spec.toolChoice != null && typeof spec.toolChoice === 'object');

    let tools: UnifiedTool[] = [];
    let mcpServers: string[] = [];
    let toolNameMap: Record<string, string> = {};
    let vectorSearchAliasMap: Record<string, string> | undefined;

    if (needsTools) {
      await this.ensureToolCoordinator(executionSpec);
      [tools, mcpServers, toolNameMap, vectorSearchAliasMap] = await this.collectTools(executionSpec);

      // Update vector context with alias map after collectTools generates it
      if (vectorSearchAliasMap) {
        this.toolCoordinator.setVectorContext(executionSpec.vectorContext, this.registry, vectorSearchAliasMap);
      }

      // Sanitize toolChoice to match sanitized tool names
      const { sanitizeToolChoice } = await import('../../tools/index.js');
      executionSpec.toolChoice = sanitizeToolChoice(executionSpec.toolChoice);
    }

    const runContext = {
      tools: tools.map(t => t.name),
      mcpServers,
      toolNameMap,
      metadata: spec.metadata
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

          await this.attachUsageCostIfNeeded(response, mergedSettings, providerManifest.id, item.model);
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

          await this.attachUsageCostIfNeeded(response, mergedSettings, providerManifest.id, item.model);
          this.ensureValidAssistantResponse(response, providerManifest.id);

          return response;
        }
      };
    });
    
    if (!sequence.length) {
      throw new Error('LLMCallSpec.llmPriority must include at least one provider');
    }
    
    const retryDefaults = getDefaults().retry;
    const retryPolicy = {
      maxAttempts: retryDefaults.maxAttempts,
      baseDelayMs: retryDefaults.baseDelayMs,
      multiplier: retryDefaults.multiplier,
      rateLimitDelays: executionSpec.rateLimitRetryDelays || retryDefaults.rateLimitDelays
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

    // Tools are optional; avoid importing tool code unless actually needed.
    const needsTools = (spec.tools && spec.tools.length > 0) ||
                      (spec.functionToolNames && spec.functionToolNames.length > 0) ||
                      (spec.mcpServers && spec.mcpServers.length > 0) ||
                      (spec.vectorPriority && spec.vectorPriority.length > 0) ||
                      this.shouldCreateVectorTool(spec) ||
                      typeof spec.toolChoice === 'object';

    let tools: UnifiedTool[] = [];
    let mcpServers: string[] = [];
    let toolNameMap: Record<string, string> = {};
    let vectorSearchAliasMap: Record<string, string> | undefined;

    if (needsTools) {
      await this.ensureToolCoordinator(executionSpec);
      [tools, mcpServers, toolNameMap, vectorSearchAliasMap] = await this.collectTools(executionSpec);

      // Update vector context with alias map after collectTools generates it
      if (vectorSearchAliasMap) {
        this.toolCoordinator.setVectorContext(executionSpec.vectorContext, this.registry, vectorSearchAliasMap);
      }

      // Sanitize toolChoice to match sanitized tool names
      const { sanitizeToolChoice } = await import('../../tools/index.js');
      streamExecutionSpec.toolChoice = sanitizeToolChoice(streamExecutionSpec.toolChoice);
    }

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
      logger: runLogger,
      metadata: spec.metadata
    };

    yield* streamCoordinator.coordinateStream(
      streamExecutionSpec,
      messages,
      tools,
      context,
      { requireFinishToExecute: true }
    );
  }

  // Intentionally retained for tests (accessed via `(coordinator as any)`).
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

    const toolDefaults = getDefaults().tools;
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
      const targetToolName = toolNameMap[toolCall.name] ?? toolCall.name;

      logger.info('Invoking tool', {
        toolName: targetToolName,
        callId: toolCall.id
      });

      try {
        const result = await this.toolCoordinator.routeAndInvoke(
          targetToolName,
          toolCall.id,
          toolCall.arguments,
          {
            provider: providerManifest.id,
            model,
            metadata: spec.metadata,
            logger
          }
        );

        appendToolResult(messages, {
          toolName: targetToolName,
          callId: toolCall.id,
          result,
          resultText: typeof result === 'string' ? result : JSON.stringify(result)
        });
      } catch (error) {
        logger.error('Tool execution failed', {
          toolName: targetToolName,
          callId: toolCall.id,
          error: error instanceof Error ? error.message : String(error)
        });

        // Add error as tool result
        const errorResult = {
          error: 'tool_execution_failed',
          message: error instanceof Error ? error.message : String(error)
        };

        appendToolResult(messages, {
          toolName: targetToolName,
          callId: toolCall.id,
          result: errorResult,
          resultText: JSON.stringify(errorResult)
        });
      }
    }

    // Prune old tool results and reasoning before follow-up stream
    pruneToolResults(messages, preserveToolResults);
    pruneReasoning(messages, preserveReasoning);

    const compat = await this.registry.getCompatModule(providerManifest.compat);

    let followUpStream;
    try {
      followUpStream = this.llmManager.streamProvider(
        providerManifest,
        model,
        spec.settings,
        messages,
        tools,
        toolChoice,
        providerExtras,
        logger,
        { metadata: spec.metadata }
      );
    } catch (error) {
      logger.error('Error creating follow-up stream', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    let followUpContent = '';

    try {
      for await (const chunk of followUpStream) {
        const parsed = compat.parseStreamChunk(chunk);
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

    return followUpContent;
  }

  private async handleTools(
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
    const hasToolCalls = Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
    if (!hasToolCalls) {
      return response;
    }

    // Ensure the proxy has a current spec if it needs to lazily initialize the tool coordinator.
    this.activeToolSpec = spec;

    const { runToolLoop } = await import('../../tools/index.js');

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

  private sanitizeToolName(name: string): string {
    return sanitizeToolName(name);
  }

  private shouldCalculateUsageCost(settings: LLMCallSettings): boolean {
    const defaults = getDefaults();
    return normalizeFlag(settings.usageCost, defaults.usageCost);
  }

  private async attachUsageCostIfNeeded(
    response: LLMResponse,
    settings: LLMCallSettings,
    provider: string,
    model: string
  ): Promise<void> {
    if (!response?.usage) return;
    if (typeof response.usage.cost === 'number') return;
    if (!this.shouldCalculateUsageCost(settings)) return;

    const { attachUsageCostIfMissing } = await import('../../usage-cost/index.js');
    attachUsageCostIfMissing({
      usage: response.usage,
      provider,
      model
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
    const { collectTools } = await import('../../tools/index.js');
    const result = await collectTools({
      spec,
      registry: this.registry,
      mcpManager: this.mcpManager,
      vectorManager: this.vectorManager
    });
    return [result.tools, result.mcpServers, result.toolNameMap, result.vectorSearchAliasMap];
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
        const { VectorStoreManager } = await import('../../vector/index.js');
        this.vectorManager = new VectorStoreManager(
          new Map(),  // configs - will be loaded from registry
          new Map(),  // adapters - will be created via compat
          undefined,  // embedder - not needed, we use EmbeddingManager directly
          this.registry,
          this.logging.getVectorLogger()
        );
      }

      // Lazy-load EmbeddingManager with logger for embedding request/response logging
      const { EmbeddingManager } = await import('../../embeddings/index.js');
      const embeddingManager = new EmbeddingManager(
        this.registry,
        this.logging.getEmbeddingLogger()
      );

      // Lazy-load VectorContextInjector
      const { VectorContextInjector } = await import('../../vector/index.js');
      this.vectorContextInjector = new VectorContextInjector({
        registry: this.registry,
        embeddingManager,
        vectorManager: this.vectorManager
      });
    }
    return this.vectorContextInjector;
  }
}
