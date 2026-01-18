import type {
  LLMCallSpec,
  LLMStreamEvent,
  Message,
  UnifiedTool,
  RuntimeSettings,
  PluginRegistry,
  AdapterLogger,
  ObservabilityContext
} from '../../../../../kernel/index.js';
import type { LLMManager } from '../../llm-manager.js';
import { partitionSettings, mergeProviderSettings } from '../../../../settings/index.js';

export async function* runStream(options: {
  spec: LLMCallSpec;
  registry: PluginRegistry;
  llmManager: LLMManager;
  toolCoordinator: any;
  getLogger: () => AdapterLogger;
  applyRuntimeEnvironment: (runtime: RuntimeSettings) => Promise<void>;
  createObservabilityContext: (spec: LLMCallSpec, runtime: RuntimeSettings) => Promise<ObservabilityContext | undefined>;
  prepareMessages: (spec: LLMCallSpec) => Message[];
  shouldInjectVectorContext: (spec: LLMCallSpec) => boolean;
  shouldCreateVectorTool: (spec: LLMCallSpec) => boolean;
  ensureVectorContextInjector: () => Promise<{ injectContext: (...args: any[]) => Promise<{ messages: Message[] }> }>;
  ensureToolCoordinator: (spec: LLMCallSpec) => Promise<any>;
  collectTools: (spec: LLMCallSpec) => Promise<[UnifiedTool[], string[], Record<string, string>, Record<string, string> | undefined]>;
}): AsyncGenerator<LLMStreamEvent> {
  if (!options.spec.llmPriority.length) {
    throw new Error('LLMCallSpec.llmPriority must include at least one provider');
  }

  // Streaming delegates to StreamCoordinator, which re-partitions settings (runtime vs provider) and
  // needs access to the *runtime* settings for tool loop behavior (truncation, countdown, budgets, etc).
  // Keep the original settings on the spec and only extract runtime here for environment overrides.
  const { runtime } = partitionSettings(options.spec.settings);
  await options.applyRuntimeEnvironment(runtime);

  const executionSpec: LLMCallSpec = {
    ...options.spec,
    settings: options.spec.settings
  };

  const providerPref = executionSpec.llmPriority[0];

  // Merge per-provider settings for streaming (only first provider is used)
  const mergedSettings = mergeProviderSettings(executionSpec.settings, providerPref.settings);
  const streamExecutionSpec: LLMCallSpec = {
    ...executionSpec,
    settings: mergedSettings
  };

  const providerManifest = await options.registry.getProvider(providerPref.provider);
  let messages = options.prepareMessages(streamExecutionSpec);

  // Inject vector context if configured for auto or both mode
  if (options.shouldInjectVectorContext(options.spec)) {
    const injector = await options.ensureVectorContextInjector();
    const injectionResult = await injector.injectContext(
      messages,
      options.spec.vectorContext!,
      options.spec.systemPrompt
    );
    messages = injectionResult.messages;
  }

  // Tools are optional; avoid importing tool code unless actually needed.
  const needsTools = (options.spec.tools && options.spec.tools.length > 0) ||
                    (options.spec.functionToolNames && options.spec.functionToolNames.length > 0) ||
                    (options.spec.mcpServers && options.spec.mcpServers.length > 0) ||
                    (options.spec.vectorPriority && options.spec.vectorPriority.length > 0) ||
                    options.shouldCreateVectorTool(options.spec) ||
                    (options.spec.toolChoice != null && typeof options.spec.toolChoice === 'object');

  let tools: UnifiedTool[] = [];
  let mcpServers: string[] = [];
  let toolNameMap: Record<string, string> = {};
  let vectorSearchAliasMap: Record<string, string> | undefined;

  if (needsTools) {
    await options.ensureToolCoordinator(executionSpec);
    [tools, mcpServers, toolNameMap, vectorSearchAliasMap] = await options.collectTools(executionSpec);

    // Update vector context with alias map after collectTools generates it
    if (vectorSearchAliasMap) {
      options.toolCoordinator.setVectorContext(executionSpec.vectorContext, options.registry, vectorSearchAliasMap);
    }

    // Sanitize toolChoice to match sanitized tool names
    const { sanitizeToolChoice } = await import('../../../../tools/index.js');
    streamExecutionSpec.toolChoice = sanitizeToolChoice(streamExecutionSpec.toolChoice);
  }

  const runLogger = options.getLogger().withCorrelation(options.spec.metadata?.correlationId as string);
  runLogger.info('Streaming call started', {
    provider: providerManifest.id,
    model: providerPref.model,
    tools: tools.map(t => t.name),
    mcpServers
  });

  // Create observability context if enabled (lazy-loads observability module)
  const observability = await options.createObservabilityContext(options.spec, runtime);

  // Delegate streaming to StreamCoordinator
  const streamCoordinator = new (await import('../../stream-coordinator.js')).StreamCoordinator(
    options.registry,
    options.llmManager,
    options.toolCoordinator
  );

  const context = {
    provider: providerManifest.id,
    model: providerPref.model,
    tools,
    mcpServers,
    toolNameMap: new Map<string, string>(Object.entries(toolNameMap)),
    logger: runLogger,
    metadata: options.spec.metadata,
    observability
  };

  yield* streamCoordinator.coordinateStream(
    streamExecutionSpec,
    messages,
    tools,
    context,
    { requireFinishToExecute: true }
  );
}
