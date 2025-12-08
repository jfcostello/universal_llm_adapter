import {
  LLMCallSpec,
  LLMStreamEvent,
  StreamEventType,
  ToolCallEventType,
  Message,
  Role,
  RuntimeSettings,
  UsageStats,
  ReasoningData
} from '../core/types.js';
import { ToolCoordinator } from '../utils/tools/tool-coordinator.js';
import { AdapterLogger } from '../core/logging.js';
import { pruneToolResults, pruneReasoning } from '../utils/context/context-manager.js';
import { partitionSettings } from '../utils/settings/settings-partitioner.js';
import { runToolLoop } from '../utils/tools/tool-loop.js';
import { usageStatsToJson } from '../utils/usage/usage-utils.js';

interface StreamingContext {
  provider: string;
  model: string;
  tools: any[];
  mcpServers: string[];
  toolNameMap: Map<string, string>;
  logger: AdapterLogger;
}

export class StreamCoordinator {
  constructor(
    private registry: any,
    private llmManager: any,
    private toolCoordinator: ToolCoordinator
  ) {}

  async *coordinateStream(
    spec: LLMCallSpec,
    messages: Message[],
    tools: any[],
    context: StreamingContext,
    options?: { requireFinishToExecute?: boolean }
  ): AsyncGenerator<LLMStreamEvent> {
    const { runtime, provider: providerSettings, providerExtras } = partitionSettings(spec.settings);
    const executionSpec: LLMCallSpec = {
      ...spec,
      settings: providerSettings
    };

    const { provider, model } = executionSpec.llmPriority[0];
    const providerManifest = await this.registry.getProvider(provider);

    // Get compat module for parsing stream chunks
    const compat = await this.registry.getCompatModule(providerManifest.compat);

    // Track accumulated content and tool calls for final response
    let accumulatedContent = '';
    const allToolCalls: any[] = [];

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
      context.logger
    );

    let hasToolCalls = false;
    const detectedCalls: any[] = [];
    let latestUsage: UsageStats | undefined;
    let reasoningAggregate: ReasoningData | undefined;

    for await (const chunk of stream) {
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
            context.logger.info('[STREAM-COORD] TOOL_CALL_END received', {
              callId: event.callId,
              pendingToolCallsSize: pendingToolCalls.size,
              hasPendingState: pendingToolCalls.has(event.callId)
            });
            const state = pendingToolCalls.get(event.callId);
            context.logger.info('[STREAM-COORD] State retrieved', { hasState: !!state, state });
            if (state) {
              const toolCall: any = {
                id: event.callId,
                name: state.name || event.name,
                arguments: state.arguments || event.arguments
              };
              // Preserve provider-specific metadata (e.g., Google's thoughtSignature)
              if (state.metadata) {
                toolCall.metadata = state.metadata;
              }
              detectedCalls.push(toolCall);

              // Track for final response (map name back to original and parse args)
              const toolName = toolCall.name || 'unknown';
              const originalName = context.toolNameMap.get(toolName) || toolName;
              const finalToolCall: any = {
                id: toolCall.id,
                name: originalName,
                arguments: JSON.parse(toolCall.arguments || '{}'),
                args: JSON.parse(toolCall.arguments || '{}') // Alias for tests
              };
              // Preserve provider-specific metadata (e.g., Google's thoughtSignature)
              if (state.metadata) {
                finalToolCall.metadata = state.metadata;
              }
              allToolCalls.push(finalToolCall);

              // Emit tool_call event for tests
              context.logger.info('[STREAM-COORD] Yielding tool_call event', { toolCallName: finalToolCall.name, callId: event.callId });
              yield {
                type: 'tool_call' as any,
                toolCall: finalToolCall
              };

              pendingToolCalls.delete(event.callId);
            }
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
    if ((mustRequireFinish && finishedWithToolCalls) || (!mustRequireFinish && (finishedWithToolCalls || detectedCalls.length > 0))) {
      // If we didn't receive TOOL_CALL_END events, finalize using pending state
      if (pendingToolCalls.size > 0) {
        for (const [callId, state] of pendingToolCalls.entries()) {
          const pendingCall: any = {
            id: callId,
            name: state.name,
            arguments: state.arguments
          };
          // Preserve provider-specific metadata (e.g., Google's thoughtSignature)
          if (state.metadata) {
            pendingCall.metadata = state.metadata;
          }
          detectedCalls.push(pendingCall);
        }
        pendingToolCalls.clear();
      }

      if (detectedCalls.length === 0) {
        // Nothing to execute
        // Continue to final DONE emission below
      } else {
      // Emit tool_call events and record for final DONE
      for (const call of detectedCalls) {
        const originalName = context.toolNameMap.get(call.name || '') || call.name || 'unknown';
        const parsedArgs = call.arguments ? JSON.parse(call.arguments) : {};
        const finalToolCall: any = {
          id: call.id,
          name: originalName,
          arguments: parsedArgs,
          args: parsedArgs
        };
        // Preserve provider-specific metadata (e.g., Google's thoughtSignature)
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
          arguments: JSON.parse(call.arguments || '{}')
        };
        // Preserve provider-specific metadata (e.g., Google's thoughtSignature)
        if (call.metadata) {
          prepared.metadata = call.metadata;
        }
        return prepared;
      });

      const toolNameMap = Object.fromEntries(context.toolNameMap.entries());

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
      if (followUpResult?.content) {
        accumulatedContent += followUpResult.content;
      }
      if (followUpResult?.usage) {
        latestUsage = followUpResult.usage;
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
      }
    }

    // Signal completion with final response
    yield {
      type: StreamEventType.DONE,
      response: {
        provider,
        model,
        role: 'assistant' as any,
        content: [{ type: 'text', text: accumulatedContent }],
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        finishReason: hasToolCalls ? 'tool_calls' : 'stop',
        usage: latestUsage,
        reasoning: reasoningAggregate
      }
    };
  }

}
