import { randomUUID } from 'crypto';

import type {
  LLMCallSpec,
  LLMResponse,
  Message,
  UnifiedTool,
  LLMCallSettings,
  RuntimeSettings,
  PluginRegistry,
  AdapterLogger,
  RunContext,
  ObservabilityContext
} from '../../../../../kernel/index.js';
import { getDefaults } from '../../../../../kernel/index.js';
import type { LLMManager } from '../../llm-manager.js';
import { partitionSettings, mergeProviderSettings } from '../../../../settings/index.js';
import { withRetries } from '../../../../retry/index.js';

export async function runNonStream(options: {
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
  attachUsageCostIfNeeded: (response: LLMResponse, settings: LLMCallSettings, provider: string, model: string) => Promise<void>;
  ensureValidAssistantResponse: (response: LLMResponse, providerId: string | undefined) => void;
  handleTools: (
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
  ) => Promise<LLMResponse>;
}): Promise<LLMResponse> {
  const { runtime, provider } = partitionSettings(options.spec.settings);
  await options.applyRuntimeEnvironment(runtime);

  const executionSpec: LLMCallSpec = {
    ...options.spec,
    settings: provider
  };

  let messages = options.prepareMessages(executionSpec);

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
    executionSpec.toolChoice = sanitizeToolChoice(executionSpec.toolChoice);
  }

  // Create observability context if enabled (lazy-loads observability module)
  const observability = await options.createObservabilityContext(options.spec, runtime);

  const runContext: RunContext = {
    tools: tools.map(t => t.name),
    mcpServers,
    toolNameMap,
    metadata: options.spec.metadata,
    observability
  };

  const runLogger = options.getLogger().withCorrelation(options.spec.metadata?.correlationId as string);

  // Build retry sequence
  const sequence = options.spec.llmPriority.map(item => {
    // Merge per-provider settings with global settings
    const mergedSettings = mergeProviderSettings(executionSpec.settings, item.settings);
    const { providerExtras } = partitionSettings(mergedSettings);

    return {
      provider: item.provider,
      model: item.model,
      fn: async () => {
        // Keep retry attempts isolated: tool loops mutate the messages array, so each attempt must
        // start from a fresh copy to avoid leaking tool-call artifacts into subsequent retries.
        const attemptMessages = messages.slice();
        const providerManifest = await options.registry.getProvider(item.provider);

        runLogger.info('Calling provider endpoint', {
          provider: providerManifest.id,
          model: item.model,
          tools: runContext.tools,
          mcpServers: runContext.mcpServers,
          hasPerProviderSettings: !!item.settings
        });

        const callRunContext = runContext.observability
          ? { ...runContext, generationId: randomUUID() }
          : runContext;

        let response = await options.llmManager.callProvider(
          providerManifest,
          item.model,
          mergedSettings,
          attemptMessages,
          tools,
          executionSpec.toolChoice,
          providerExtras,
          runLogger,
          callRunContext
        );

        await options.attachUsageCostIfNeeded(response, mergedSettings, providerManifest.id, item.model);
        options.ensureValidAssistantResponse(response, providerManifest.id);

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

        response = await options.handleTools(
          providerSpec,
          runtime,
          providerExtras,
          providerManifest,
          item.model,
          attemptMessages,
          tools,
          response,
          runLogger,
          callRunContext,
          toolNameMap
        );

        await options.attachUsageCostIfNeeded(response, mergedSettings, providerManifest.id, item.model);
        options.ensureValidAssistantResponse(response, providerManifest.id);

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
  options.ensureValidAssistantResponse(response, response.provider);
  return response;
}
