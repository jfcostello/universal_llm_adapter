import type {
  LLMCallSpec,
  LLMResponse,
  LLMStreamEvent,
  Message,
  UnifiedTool,
  LLMCallSettings,
  RuntimeSettings,
  VectorContextConfig,
  PluginRegistry,
  AdapterLogger,
  LoggingDeps,
  ObservabilityContext
} from '../../../../kernel/index.js';
import {
  Role,
  sanitizeToolName,
  ProviderExecutionError,
  getDefaults,
  resolveLoggingDeps
} from '../../../../kernel/index.js';
import { LLMManager } from '../llm-manager.js';
import { normalizeFlag, parseNonNegativeInt } from '../../../shared/index.js';

import type { MCPManager } from '../../../mcp/index.js';
import type { VectorStoreManager, VectorContextInjector } from '../../../vector/index.js';
import { prepareMessagesWithDocuments } from './internal/prepare-messages.js';
import { runNonStream } from './internal/run-nonstream.js';
import { runStream } from './internal/run-stream.js';

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
        const { MCPManager } = await import('../../../mcp/index.js');
        this.mcpManager = new MCPManager(mcpServers, { logging: this.logging });
      }
    }

    const processRoutes = await this.registry.getProcessRoutes();
    const { ToolCoordinator } = await import('../../../tools/index.js');
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

  /**
   * Create observability context if observability is enabled.
   * Lazy-loads the observability module only when needed.
   */
  private async createObservabilityContext(
    spec: LLMCallSpec,
    runtime: RuntimeSettings
  ): Promise<ObservabilityContext | undefined> {
    const defaults = getDefaults().observability;
    const obsSpec = spec.observability;

    // Determine if observability is enabled
    const enabled = obsSpec?.enabled ?? defaults.enabled;
    if (!enabled) {
      return undefined;
    }

    const { createObservabilityRuntime } = await import('../../../observability/index.js');
    const runtimeObs = await createObservabilityRuntime(this.registry, obsSpec, {
      metadata: spec.metadata,
      runtime,
      // Use the base logger (no correlation) because the exporter can be shared across many calls.
      logger: this.logger,
      sessionIdFallback: 'batch'
    });

    if (!runtimeObs) {
      return undefined;
    }

    const { baseTraceId, ...rest } = runtimeObs;
    return { ...rest, traceId: baseTraceId };
  }

  async run(spec: LLMCallSpec): Promise<LLMResponse> {
    return runNonStream({
      spec,
      registry: this.registry,
      llmManager: this.llmManager,
      toolCoordinator: this.toolCoordinator,
      getLogger: () => this.logger,
      applyRuntimeEnvironment: this.applyRuntimeEnvironment.bind(this),
      createObservabilityContext: this.createObservabilityContext.bind(this),
      prepareMessages: this.prepareMessages.bind(this),
      shouldInjectVectorContext: this.shouldInjectVectorContext.bind(this),
      shouldCreateVectorTool: this.shouldCreateVectorTool.bind(this),
      ensureVectorContextInjector: this.ensureVectorContextInjector.bind(this),
      ensureToolCoordinator: this.ensureToolCoordinator.bind(this),
      collectTools: this.collectTools.bind(this),
      attachUsageCostIfNeeded: this.attachUsageCostIfNeeded.bind(this),
      ensureValidAssistantResponse: this.ensureValidAssistantResponse.bind(this),
      handleTools: this.handleTools.bind(this)
    });
  }

  async *runStream(spec: LLMCallSpec): AsyncGenerator<LLMStreamEvent> {
    yield* runStream({
      spec,
      registry: this.registry,
      llmManager: this.llmManager,
      toolCoordinator: this.toolCoordinator,
      getLogger: () => this.logger,
      applyRuntimeEnvironment: this.applyRuntimeEnvironment.bind(this),
      createObservabilityContext: this.createObservabilityContext.bind(this),
      prepareMessages: this.prepareMessages.bind(this),
      shouldInjectVectorContext: this.shouldInjectVectorContext.bind(this),
      shouldCreateVectorTool: this.shouldCreateVectorTool.bind(this),
      ensureVectorContextInjector: this.ensureVectorContextInjector.bind(this),
      ensureToolCoordinator: this.ensureToolCoordinator.bind(this),
      collectTools: this.collectTools.bind(this)
    });
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

    const { runToolLoop } = await import('../../../tools/index.js');
    const toolBySanitizedName = new Map(tools.map(tool => [tool.name, tool]));
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
        const toolDef = toolBySanitizedName.get(call.name);
        const toolId = typeof toolDef?.id === 'string' ? String(toolDef.id).trim() || undefined : undefined;
        const toolProcessRouteId =
          typeof toolDef?.processRouteId === 'string' ? String(toolDef.processRouteId).trim() || undefined : undefined;
        const toolRouting = spec.toolRouting;
        const routeFromName = toolRouting?.routesByName?.[toolName];
        const routeFromId = toolId ? toolRouting?.routesById?.[toolId] : undefined;
        const processRouteId = typeof routeFromName === 'string' && routeFromName.trim()
          ? routeFromName.trim()
          : typeof routeFromId === 'string' && routeFromId.trim()
            ? routeFromId.trim()
            : toolProcessRouteId;

        return this.toolCoordinator.routeAndInvoke(
          toolName,
          call.id,
          call.arguments,
          {
            provider: context.provider,
            model: context.model,
            metadata: context.metadata,
            logger: context.logger,
            callProgress: context.callProgress,
            toolId,
            processRouteId
          }
        );
      }
    });
  }

  private parseMaxToolIterations(value: unknown): number {
    const toolDefaults = getDefaults().tools;
    return parseNonNegativeInt(value, toolDefaults.maxIterations);
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

    const { attachUsageCostIfMissing } = await import('../../../usage-cost/index.js');
    attachUsageCostIfMissing({
      usage: response.usage,
      provider,
      model
    });
  }

  async close(): Promise<void> {
    await Promise.all([
      this.toolCoordinator.close(),
      this.mcpManager?.close()
    ]);
  }

  private prepareMessages(spec: LLMCallSpec): Message[] {
    return prepareMessagesWithDocuments(spec);
  }

  private async collectTools(spec: LLMCallSpec): Promise<[UnifiedTool[], string[], Record<string, string>, Record<string, string> | undefined]> {
    const { collectTools } = await import('../../../tools/index.js');
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
        const { VectorStoreManager } = await import('../../../vector/index.js');
        this.vectorManager = new VectorStoreManager(
          new Map(),  // configs - will be loaded from registry
          new Map(),  // adapters - will be created via compat
          undefined,  // embedder - not needed, we use EmbeddingManager directly
          this.registry,
          this.logging.getVectorLogger()
        );
      }

      // Lazy-load EmbeddingManager with logger for embedding request/response logging
      const { EmbeddingManager } = await import('../../../embeddings/index.js');
      const embeddingManager = new EmbeddingManager(
        this.registry,
        this.logging.getEmbeddingLogger()
      );

      // Lazy-load VectorContextInjector
      const { VectorContextInjector } = await import('../../../vector/index.js');
      this.vectorContextInjector = new VectorContextInjector({
        registry: this.registry,
        embeddingManager,
        vectorManager: this.vectorManager
      });
    }
    return this.vectorContextInjector;
  }
}
