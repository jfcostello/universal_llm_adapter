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
import { StreamEventType, ToolCallEventType, getDefaults, safeJsonParse } from '../../../kernel/index.js';
import { monotonicNowNs, normalizeFlag } from '../../shared/index.js';
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
  constructor(
    private registry: any,
    private llmManager: any,
    private toolCoordinator: any
  ) {}

  async *coordinateStream(
    spec: LLMCallSpec,
    messages: Message[],
    tools: any[],
    context: StreamingContext,
    options?: { requireFinishToExecute?: boolean }
  ): AsyncGenerator<LLMStreamEvent> {
    const startTimeMs = Date.now();
    const startTimeMonoNs = monotonicNowNs();
    const generationId = context.observability ? randomUUID() : undefined;
    const { runtime, provider: providerSettings, providerExtras } = partitionSettings(spec.settings);
    const executionSpec: LLMCallSpec = {
      ...spec,
      settings: providerSettings
    };

    const { provider, model } = executionSpec.llmPriority[0];
    const providerManifest = await this.registry.getProvider(provider);

    // Get compat module for parsing stream chunks
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

    // Track accumulated content and tool calls for final response
    let accumulatedContent = '';
    const allToolCalls: any[] = [];
    let upstreamProviderHint: string | undefined;

    // Track accumulated tool calls
    const pendingToolCalls = new Map<string, {
      name?: string;
      arguments: string;
      metadata?: Record<string, any>;
    }>();
    let finishedWithToolCalls = false;

    // Stream the initial response
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

    let hasToolCalls = false;
    let toolStop = false;
    const detectedCallsById = new Map<string, any>();
    let latestUsage: UsageStats | undefined;
    let reasoningAggregate: ReasoningData | undefined;

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

      // Parse chunk using compat module
      const parsed = compat.parseStreamChunk(chunk);

      // Extract text token if present
      if (parsed.text) {
        accumulatedContent += parsed.text;
        yield {
          type: StreamEventType.DELTA,
          content: parsed.text
        };
      }

      // Process tool call events from compat module
      if (parsed.toolEvents) {
        for (const event of parsed.toolEvents) {
          hasToolCalls = true;

          // Track tool call state
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

          // Emit tool event
          yield {
            type: StreamEventType.TOOL,
            toolEvent: event
          };
        }
      }

      // Check if provider signaled finishing with tool calls
      if (parsed.finishedWithToolCalls) {
        finishedWithToolCalls = true;
      }

      if (parsed.usage) {
        latestUsage = parsed.usage;
        yield {
          type: StreamEventType.TOKEN,
          metadata: { usage: usageStatsToJson(parsed.usage) }
        };
      }

      if (parsed.reasoning?.text) {
        if (!reasoningAggregate) {
          reasoningAggregate = {
            text: parsed.reasoning.text,
            metadata: parsed.reasoning.metadata
          };
        } else {
          reasoningAggregate.text += parsed.reasoning.text;
          if (parsed.reasoning.metadata) {
            reasoningAggregate.metadata = {
              ...(reasoningAggregate.metadata ?? {}),
              ...parsed.reasoning.metadata
            };
          }
        }
      }
    }

    // Handle tool calls if stream finished with tool_calls (matches prior behavior)
    const mustRequireFinish = options?.requireFinishToExecute === true;
    if ((mustRequireFinish && finishedWithToolCalls) || (!mustRequireFinish && (finishedWithToolCalls || detectedCallsById.size > 0))) {
      // If we didn't receive TOOL_CALL_END events, finalize using pending state
      if (pendingToolCalls.size > 0) {
        for (const [callId, state] of pendingToolCalls.entries()) {
          if (detectedCallsById.has(callId)) continue;
          const pendingCall: any = {
            id: callId,
            name: state.name,
            arguments: state.arguments
          };
          // Preserve provider-specific metadata (e.g., signed/opaque fields required on follow-ups)
          if (state.metadata) {
            pendingCall.metadata = state.metadata;
          }
          detectedCallsById.set(callId, pendingCall);
        }
        pendingToolCalls.clear();
      }

      const detectedCalls = Array.from(detectedCallsById.values());

      if (detectedCalls.length === 0) {
        // Nothing to execute
        // Continue to final DONE emission below
      } else {
        // Emit tool_call events and record for final DONE
        for (const call of detectedCalls) {
          const originalName = context.toolNameMap.get(call.name || '') || call.name || 'unknown';
          const parsedArgs = safeJsonParse<Record<string, any>>(call.arguments, {}) as Record<string, any>;
          const finalToolCall: any = {
            id: call.id,
            name: originalName,
            arguments: parsedArgs,
            args: parsedArgs
          };
          // Preserve provider-specific metadata (e.g., signed/opaque fields required on follow-ups)
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
          // Preserve provider-specific metadata (e.g., signed/opaque fields required on follow-ups)
          if (call.metadata) {
            prepared.metadata = call.metadata;
          }
          return prepared;
        });

        const toolNameMap = Object.fromEntries(context.toolNameMap.entries());

        const { runToolLoop } = await import('../../tools/index.js');
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
          runContext: { metadata: executionSpec.metadata, observability: context.observability },
          metadata: executionSpec.metadata,
          initialToolCalls: preparedToolCalls,
          initialReasoning: reasoningAggregate,
          invokeTool: async (toolName, call) => {
            return this.toolCoordinator.routeAndInvoke(
              toolName,
              call.id,
              call.arguments,
              {
                provider,
                model,
                metadata: executionSpec.metadata,
                logger: context.logger
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

    // Signal completion with final response
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
