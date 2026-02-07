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
import { StreamEventType } from '../../../../../kernel/index.js';
import type { LLMManager } from '../../llm-manager.js';
import { partitionSettings, mergeProviderSettings } from '../../../../settings/index.js';
import {
  resolveAutoVectorContexts,
  resolveVectorContexts,
  resolveVectorRequestPolicy,
  withTimeout
} from './vector-contexts.js';

const MAX_BUFFERED_PRE_DELTA_EVENTS = 256;

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
  collectTools: (spec: LLMCallSpec) => Promise<[UnifiedTool[], string[], Record<string, string>, Record<string, Record<string, string>> | undefined]>;
}): AsyncGenerator<LLMStreamEvent> {
  if (!options.spec.llmPriority.length) {
    throw new Error('LLMCallSpec.llmPriority must include at least one provider');
  }

  const { runtime } = partitionSettings(options.spec.settings);
  await options.applyRuntimeEnvironment(runtime);

  const executionSpec: LLMCallSpec = {
    ...options.spec,
    settings: options.spec.settings
  };

  const vectorContexts = resolveVectorContexts(options.spec);
  const vectorPolicy = resolveVectorRequestPolicy(options.spec);
  let messages = options.prepareMessages(executionSpec);

  if (options.shouldInjectVectorContext(options.spec)) {
    const logger = options.getLogger().withCorrelation(options.spec.metadata?.correlationId as string);
    const injector = await options.ensureVectorContextInjector();
    const autoContexts = resolveAutoVectorContexts(vectorContexts, vectorPolicy);
    const embeddingCache = new Map<string, number[]>();
    const startedAt = Date.now();

    for (const contextConfig of autoContexts) {
      const elapsed = Date.now() - startedAt;
      const remainingBudget = vectorPolicy.totalAutoBudgetMs - elapsed;
      if (remainingBudget <= 0) {
        logger.warning?.('Vector auto-injection budget exhausted; skipping remaining contexts', {
          totalAutoBudgetMs: vectorPolicy.totalAutoBudgetMs
        });
        break;
      }

      const timeoutMs = Math.min(vectorPolicy.perContextTimeoutMs, remainingBudget);
      try {
        const injectionResult = await withTimeout(
          injector.injectContext(messages, contextConfig, options.spec.systemPrompt, {
            maxInjectedPayloadBytes: vectorPolicy.maxInjectedPayloadBytes,
            embeddingCache
          }),
          timeoutMs,
          'vector context injection'
        );
        messages = injectionResult.messages;
      } catch (error: any) {
        if (String(error?.code ?? '') === 'config_error') {
          throw error;
        }
        logger.warning?.('Vector context injection skipped due to error', {
          error: error?.message ?? String(error),
          mode: contextConfig.mode,
          stores: contextConfig.stores
        });
      }
    }
  }

  const needsTools = (options.spec.tools && options.spec.tools.length > 0) ||
                    (options.spec.functionToolNames && options.spec.functionToolNames.length > 0) ||
                    (options.spec.mcpServers && options.spec.mcpServers.length > 0) ||
                    (options.spec.vectorPriority && options.spec.vectorPriority.length > 0) ||
                    options.shouldCreateVectorTool(options.spec) ||
                    (options.spec.toolChoice != null && typeof options.spec.toolChoice === 'object');

  let tools: UnifiedTool[] = [];
  let mcpServers: string[] = [];
  let toolNameMap: Record<string, string> = {};
  let vectorSearchAliasMaps: Record<string, Record<string, string>> | undefined;

  if (needsTools) {
    await options.ensureToolCoordinator(executionSpec);
    [tools, mcpServers, toolNameMap, vectorSearchAliasMaps] = await options.collectTools(executionSpec);

    if (vectorSearchAliasMaps) {
      const toolVectorContexts = vectorContexts.filter(ctx => ctx.mode === 'tool' || ctx.mode === 'both');
      options.toolCoordinator.setVectorContexts(
        toolVectorContexts.length > 0 ? toolVectorContexts : undefined,
        options.registry,
        vectorSearchAliasMaps
      );
    }

    const { sanitizeToolChoice } = await import('../../../../tools/index.js');
    executionSpec.toolChoice = sanitizeToolChoice(executionSpec.toolChoice);
  }

  const runLogger = options.getLogger().withCorrelation(options.spec.metadata?.correlationId as string);
  const observability = await options.createObservabilityContext(options.spec, runtime);

  const streamCoordinator = new (await import('../../stream-coordinator.js')).StreamCoordinator(
    options.registry,
    options.llmManager,
    options.toolCoordinator
  );

  let emittedUserDelta = false;
  let bufferOverflowLogged = false;
  let buffered: LLMStreamEvent[] = [];
  let lastError: any;

  for (let i = 0; i < executionSpec.llmPriority.length; i += 1) {
    const pref = executionSpec.llmPriority[i];
    const mergedSettings = mergeProviderSettings(executionSpec.settings, pref.settings);
    const attemptSpec: LLMCallSpec = {
      ...executionSpec,
      llmPriority: [{ provider: pref.provider, model: pref.model, settings: pref.settings }],
      settings: mergedSettings
    };

    const providerManifest = await options.registry.getProvider(pref.provider);
    runLogger.info('Streaming call started', {
      attempt: i + 1,
      provider: providerManifest.id,
      model: pref.model,
      tools: tools.map(t => t.name),
      mcpServers,
      hasPerProviderSettings: !!pref.settings
    });

    const context = {
      provider: providerManifest.id,
      model: pref.model,
      tools,
      mcpServers,
      toolNameMap: new Map<string, string>(Object.entries(toolNameMap)),
      logger: runLogger,
      metadata: options.spec.metadata,
      observability
    };

    try {
      const iterator = streamCoordinator.coordinateStream(
        attemptSpec,
        messages,
        tools,
        context,
        { requireFinishToExecute: true }
      );

      for await (const event of iterator) {
        const isDelta = (event as any)?.type === StreamEventType.DELTA || (event as any)?.type === 'delta';
        if (!emittedUserDelta && isDelta) {
          emittedUserDelta = true;
          for (const bufferedEvent of buffered) {
            yield bufferedEvent;
          }
          buffered = [];
          yield event;
          continue;
        }

        if (!emittedUserDelta) {
          buffered.push(event);
          if (buffered.length > MAX_BUFFERED_PRE_DELTA_EVENTS) {
            buffered.shift();
            if (!bufferOverflowLogged) {
              runLogger.warning?.('Pre-delta stream buffer reached cap; dropping oldest events', {
                cap: MAX_BUFFERED_PRE_DELTA_EVENTS
              });
              bufferOverflowLogged = true;
            }
          }
          continue;
        }

        yield event;
      }

      if (!emittedUserDelta && buffered.length > 0) {
        for (const bufferedEvent of buffered) {
          yield bufferedEvent;
        }
      }
      return;
    } catch (error: any) {
      lastError = error;
      if (emittedUserDelta) {
        throw error;
      }

      buffered = [];
      runLogger.warning?.('Streaming attempt failed before first delta; failing over', {
        attempt: i + 1,
        provider: providerManifest.id,
        model: pref.model,
        error: error?.message ?? String(error)
      });
    }
  }

  throw lastError ?? new Error('Streaming failed: all llmPriority attempts exhausted');
}
