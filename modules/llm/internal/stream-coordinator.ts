import type {
  LLMCallSpec,
  LLMStreamEvent,
  Message,
  RuntimeSettings,
  UsageStats,
  ReasoningData,
  AdapterLogger,
  ObservabilityContext
} from '../../../kernel/index.js';
import { Role, StreamEventType, ToolCallEventType, getDefaults, safeJsonParse, sanitizeToolName } from '../../../kernel/index.js';
import { monotonicNowNs, normalizeFlag, readRequestedGenerationId } from '../../shared/index.js';
import { partitionSettings } from '../../settings/index.js';
import { usageStatsToJson } from '../../usage/index.js';
import { randomUUID } from 'crypto';
import { recordStreamLlmRequestObservability, recordStreamLlmResponseObservability } from './stream-coordinator-observability.js';

interface StreamingContext {
  provider: string;
  model: string;
  tools: any[];
  mcpServers: string[];
  toolNameMap: Map<string, string>;
  logger: AdapterLogger;
  metadata?: Record<string, any>;
  observability?: ObservabilityContext;
}
export class StreamCoordinator {
  constructor(private registry: any, private llmManager: any, private toolCoordinator: any) {}
  async *coordinateStream(
    spec: LLMCallSpec,
    messages: Message[],
    tools: any[],
    context: StreamingContext,
    options?: { requireFinishToExecute?: boolean }
  ): AsyncGenerator<LLMStreamEvent> {
    const startTimeMs = Date.now();
    const startTimeMonoNs = monotonicNowNs();
    const generationId = context.observability
      ? (readRequestedGenerationId(context.metadata) ?? randomUUID())
      : undefined;
    const { runtime, provider: providerSettings, providerExtras } = partitionSettings(spec.settings);
    const executionSpec: LLMCallSpec = {
      ...spec,
      settings: providerSettings
    };
    const { provider, model } = executionSpec.llmPriority[0];
    const providerManifest = await this.registry.getProvider(provider);
    const compat = typeof this.registry.getCompatModuleForProvider === 'function'
      ? await this.registry.getCompatModuleForProvider(providerManifest.id)
      : await this.registry.getCompatModule(providerManifest.compat);
    if (context.observability) {
      recordStreamLlmRequestObservability({
        observability: context.observability,
        logger: context.logger,
        metadata: context.metadata,
        generationId,
        timestampMs: startTimeMs,
        provider: providerManifest.id,
        model,
        messages,
        tools,
        settings: executionSpec.settings
      });
    }
    let accumulatedContent = '';
    const allToolCalls: any[] = [];
    let upstreamProviderHint: string | undefined;
    const requiresInitialToolCalls = tools.length > 0 &&
      executionSpec.toolChoice !== undefined &&
      executionSpec.toolChoice !== 'auto' &&
      executionSpec.toolChoice !== 'none';
    const maxIgnoredToolChoiceRetries = 3;
    let ignoredToolChoiceRetries = 0;
    let bufferedRequiredText: string[] = [];
    const flushBufferedRequiredText = (): LLMStreamEvent[] => {
      if (bufferedRequiredText.length === 0) return [];
      const events = bufferedRequiredText.map(content => ({ type: StreamEventType.DELTA, content } as LLMStreamEvent));
      accumulatedContent += bufferedRequiredText.join('');
      bufferedRequiredText = [];
      return events;
    };
    let hasToolCalls = false;
    let toolStop = false;
    let latestUsage: UsageStats | undefined;
    let reasoningAggregate: ReasoningData | undefined;
    let pendingToolCalls = new Map<string, { name?: string; arguments: string; metadata?: Record<string, any> }>();
    let finishedWithToolCalls = false;
    let detectedCallsById = new Map<string, any>();

    while (true) {
      pendingToolCalls = new Map();
      finishedWithToolCalls = false;
      detectedCallsById = new Map();
      hasToolCalls = false;
      latestUsage = undefined;
      reasoningAggregate = undefined;
      bufferedRequiredText = [];

      const stream = this.llmManager.streamProvider(
        providerManifest,
        model,
        executionSpec.settings,
        messages,
        tools,
        executionSpec.toolChoice,
        providerExtras,
        context.logger,
        context
      );

      for await (const chunk of stream) {
        if (context.observability && upstreamProviderHint === undefined) {
          const maybeProvider = (chunk as any)?.provider;
          if (typeof maybeProvider === 'string') {
            const trimmed = maybeProvider.trim();
            if (trimmed && trimmed !== providerManifest.id) {
              upstreamProviderHint = trimmed;
            }
          }
        }

        const parsed = compat.parseStreamChunk(chunk);

        if (parsed.text) {
          const shouldBufferRequiredText = requiresInitialToolCalls &&
            !hasToolCalls &&
            !finishedWithToolCalls &&
            detectedCallsById.size === 0 &&
            pendingToolCalls.size === 0;

          if (shouldBufferRequiredText) {
            bufferedRequiredText.push(parsed.text);
          } else {
            accumulatedContent += parsed.text;
            yield { type: StreamEventType.DELTA, content: parsed.text };
          }
        }

        if (parsed.toolEvents) {
          for (const event of flushBufferedRequiredText()) {
            yield event;
          }

          for (const event of parsed.toolEvents) {
            hasToolCalls = true;

            if (event.type === ToolCallEventType.TOOL_CALL_START) {
              pendingToolCalls.set(event.callId, {
                name: event.name,
                arguments: '',
                metadata: event.metadata
              });
            } else if (event.type === ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA) {
              const state = pendingToolCalls.get(event.callId);
              if (state) {
                state.arguments += event.argumentsDelta || '';
              }
            } else if (event.type === ToolCallEventType.TOOL_CALL_END) {
              const state = pendingToolCalls.get(event.callId);
              const toolCall: any = {
                id: event.callId,
                name: state?.name ?? event.name,
                arguments: state?.arguments || event.arguments || ''
              };

              const metadata = state?.metadata ?? event.metadata;
              if (metadata) {
                toolCall.metadata = metadata;
              }

              detectedCallsById.set(event.callId, toolCall);
              pendingToolCalls.delete(event.callId);
            }

            yield { type: StreamEventType.TOOL, toolEvent: event };
          }
        }

        if (parsed.finishedWithToolCalls) {
          finishedWithToolCalls = true;
          for (const event of flushBufferedRequiredText()) {
            yield event;
          }
        }

        if (parsed.usage) {
          latestUsage = parsed.usage;
          yield { type: StreamEventType.TOKEN, metadata: { usage: usageStatsToJson(parsed.usage) } };
        }

        if (parsed.reasoning?.text) {
          if (!reasoningAggregate) {
            reasoningAggregate = { text: parsed.reasoning.text, metadata: parsed.reasoning.metadata };
          } else {
            reasoningAggregate.text += parsed.reasoning.text;
            if (parsed.reasoning.metadata) {
              reasoningAggregate.metadata = { ...(reasoningAggregate.metadata ?? {}), ...parsed.reasoning.metadata };
            }
          }
        }
      }

      const hasDetectedCalls = finishedWithToolCalls || detectedCallsById.size > 0 || pendingToolCalls.size > 0;
      if (
        requiresInitialToolCalls &&
        !hasDetectedCalls &&
        ignoredToolChoiceRetries < maxIgnoredToolChoiceRetries
      ) {
        ignoredToolChoiceRetries += 1;
        bufferedRequiredText = [];
        messages.push({
          role: Role.USER,
          content: [{ type: 'text', text: 'You MUST call the required tool now.\nDo NOT answer with any text.\nReturn ONLY a tool call.' } as any]
        });
        continue;
      }

      for (const event of flushBufferedRequiredText()) {
        yield event;
      }

      break;
    }

    const mustRequireFinish = options?.requireFinishToExecute === true;
    if ((mustRequireFinish && finishedWithToolCalls) || (!mustRequireFinish && (finishedWithToolCalls || detectedCallsById.size > 0))) {
      if (pendingToolCalls.size > 0) {
        for (const [callId, state] of pendingToolCalls.entries()) {
          if (detectedCallsById.has(callId)) continue;
          const pendingCall: any = {
            id: callId,
            name: state.name,
            arguments: state.arguments
          };
          if (state.metadata) {
            pendingCall.metadata = state.metadata;
          }
          detectedCallsById.set(callId, pendingCall);
        }
        pendingToolCalls.clear();
      }

      const detectedCalls = Array.from(detectedCallsById.values());
      if (detectedCalls.length > 0) {
        for (const call of detectedCalls) {
          const originalName = context.toolNameMap.get(call.name || '') || call.name || 'unknown';
          const parsedArgs = safeJsonParse<Record<string, any>>(call.arguments, {}) as Record<string, any>;
          const finalToolCall: any = {
            id: call.id,
            name: originalName,
            arguments: parsedArgs,
            args: parsedArgs
          };
          if (call.metadata) {
            finalToolCall.metadata = call.metadata;
          }
          allToolCalls.push(finalToolCall);
          yield {
            type: 'tool_call' as any,
            toolCall: finalToolCall
          };
        }

        const preparedToolCalls = detectedCalls.map(call => {
          const prepared: any = {
            id: call.id,
            name: call.name,
            arguments: safeJsonParse(call.arguments, {}) as Record<string, any>
          };
          if (call.metadata) {
            prepared.metadata = call.metadata;
          }
          return prepared;
        });

        const toolNameMap = Object.fromEntries(context.toolNameMap.entries());
        const toolBySchemaName = new Map(tools.map(tool => [tool.name, tool]));

        const { runToolLoop, resolveToolRoutingHints } = await import('../../tools/index.js');
        const streamGenerator = runToolLoop({
          mode: 'stream',
          llmManager: this.llmManager,
          registry: this.registry,
          messages,
          tools,
          toolChoice: executionSpec.toolChoice,
          providerManifest,
          model,
          runtime,
          providerSettings: executionSpec.settings,
          providerExtras,
          logger: context.logger,
          toolNameMap,
          runContext: { metadata: executionSpec.metadata, observability: context.observability, generationId },
          metadata: executionSpec.metadata,
          initialToolCalls: preparedToolCalls,
          initialReasoning: reasoningAggregate,
          invokeTool: async (toolName, call, invocationContext) => {
            const schemaName = typeof (call as any)?.name === 'string' ? String((call as any).name).trim() : '';
            const toolDef = schemaName
              ? toolBySchemaName.get(schemaName) ?? toolBySchemaName.get(sanitizeToolName(schemaName))
              : undefined;
            const { toolId, processRouteId } = resolveToolRoutingHints({
              toolName,
              toolDef,
              toolRouting: executionSpec.toolRouting
            });

            return this.toolCoordinator.routeAndInvoke(
              toolName,
              call.id,
              call.arguments,
              {
                provider: invocationContext.provider,
                model: invocationContext.model,
                metadata: invocationContext.metadata,
                logger: invocationContext.logger,
                callProgress: invocationContext.callProgress,
                toolId,
                processRouteId
              }
            );
          }
        });

        const followUpResult = yield* streamGenerator;
        const followUpFinishReason = followUpResult?.finishReason;
        if (followUpResult?.content) {
          accumulatedContent += followUpResult.content;
        }
        if (followUpResult?.usage) {
          latestUsage = followUpResult.usage;
        }
        if (followUpResult?.toolCalls && followUpResult.toolCalls.length > 0) {
          allToolCalls.push(...followUpResult.toolCalls);
        }
        if (followUpResult?.reasoning) {
          if (!reasoningAggregate) {
            reasoningAggregate = { ...followUpResult.reasoning };
          } else {
            reasoningAggregate.text += followUpResult.reasoning.text;
            if (followUpResult.reasoning.metadata) {
              reasoningAggregate.metadata = {
                ...(reasoningAggregate.metadata ?? {}),
                ...followUpResult.reasoning.metadata
              };
            }
          }
        }

        if (followUpFinishReason === 'tool_stop') {
          toolStop = true;
        }
      }
    }

    if (latestUsage && typeof latestUsage.cost !== 'number') {
      const defaults = getDefaults();
      const usageCostEnabled = normalizeFlag((providerSettings as any).usageCost, defaults.usageCost);

      if (usageCostEnabled) {
        const { attachUsageCostIfMissing } = await import('../../usage-cost/index.js');
        attachUsageCostIfMissing({ usage: latestUsage, provider, model });
      }
    }

    if (context.observability) {
      recordStreamLlmResponseObservability({
        observability: context.observability,
        logger: context.logger,
        metadata: context.metadata,
        generationId,
        startTimeMonoNs,
        provider: providerManifest.id,
        model,
        providerHint: upstreamProviderHint,
        accumulatedContent,
        toolCalls: allToolCalls,
        usage: latestUsage
      });
    }

    yield {
      type: StreamEventType.DONE,
      response: {
        provider,
        model,
        role: 'assistant' as any,
        content: [{ type: 'text', text: accumulatedContent }],
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        finishReason: toolStop ? 'tool_stop' : (hasToolCalls ? 'tool_calls' : 'stop'),
        usage: latestUsage,
        reasoning: reasoningAggregate
      }
    };
  }
}
