import { Role, StreamEventType, ToolCallEventType, safeJsonParse } from '../../../../../kernel/index.js';
import type {
  LLMStreamEvent,
  ReasoningData,
  ToolCall,
  UnifiedTool,
  UsageStats
} from '../../../../../kernel/index.js';

import { ToolCallBudget } from '../../tool-budget.js';
import { usageStatsToJson } from '../../../../usage/index.js';
import { normalizeFlag } from '../../../../shared/index.js';

import { resolveFollowUpToolChoice } from './helpers.js';
import { parseMaxToolIterations } from './utils.js';
import type { StreamLoopResult, StreamToolLoopOptions } from './types.js';
import { executeStreamToolCallsRound } from './stream-execute.js';

export async function* runStreamToolLoop(options: StreamToolLoopOptions): AsyncGenerator<LLMStreamEvent, StreamLoopResult | undefined> {
  const {
    llmManager,
    registry,
    messages,
    tools,
    toolChoice,
    providerManifest,
    model,
    runtime,
    providerSettings,
    providerExtras,
    logger,
    toolNameMap,
    invokeTool,
    initialToolCalls,
    initialReasoning,
    metadata,
    runContext
  } = options;

  const compat = typeof (registry as any).getCompatModuleForProvider === 'function'
    ? await (registry as any).getCompatModuleForProvider(providerManifest.id)
    : await registry.getCompatModule(providerManifest.compat);
  const preserveToolResults = runtime.preserveToolResults ?? 3;
  const preserveReasoning = runtime.preserveReasoning ?? 3;

  const budget = new ToolCallBudget(parseMaxToolIterations(runtime.maxToolIterations));
  const toolCountdownEnabled = normalizeFlag(runtime.toolCountdownEnabled, true);
  const maxResultLength = typeof runtime.toolResultMaxChars === 'number' && runtime.toolResultMaxChars > 0
    ? Math.floor(runtime.toolResultMaxChars)
    : null;
  const toolByName = new Map<string, UnifiedTool>(tools.map(tool => [tool.name, tool]));

  const emittedToolCalls: ToolCall[] = [];
  const calledToolNames = new Set<string>();
  const maxIgnoredToolChoiceRetries = 3;
  let ignoredToolChoiceRetries = 0;

  let followUpContent = '';
  let latestUsage: UsageStats | undefined;
  let reasoningAggregate: ReasoningData | undefined;
  let terminalStop = false;

  let toolCallsToExecute: ToolCall[] = initialToolCalls;
  let toolCallReasoning: ReasoningData | undefined = initialReasoning;

  while (true) {
    if (toolCallsToExecute.length > 0) {
      const { terminalStopThisRound } = yield* executeStreamToolCallsRound({
        toolCallsToExecute,
        toolCallReasoning,
        messages,
        tools,
        toolNameMap,
        toolByName,
        budget,
        toolCountdownEnabled,
        maxResultLength,
        providerManifest,
        model,
        metadata,
        logger,
        invokeTool,
        calledToolNames,
        preserveToolResults,
        preserveReasoning
      });

      if (terminalStopThisRound) {
        terminalStop = true;
        break;
      }

      // Ensure tool calls are executed at most once; retries for ignored tool choices should not
      // re-run previously executed tool calls.
      toolCallsToExecute = [];
      toolCallReasoning = undefined;
    }

    const followUpToolChoice = budget.exhausted
      ? 'none'
      : resolveFollowUpToolChoice(toolChoice, calledToolNames);
    const requireToolCalls = followUpToolChoice !== undefined &&
      followUpToolChoice !== 'auto' &&
      followUpToolChoice !== 'none';

    const stream = llmManager.streamProvider(
      providerManifest,
      model,
      providerSettings,
      messages,
      budget.exhausted ? [] : tools,
      followUpToolChoice,
      providerExtras,
      logger,
      runContext
    );

    const pendingToolCalls = new Map<string, {
      name?: string;
      arguments: string;
      metadata?: Record<string, any>;
    }>();
    const detectedCallsById = new Map<string, any>();
    let finishedWithToolCalls = false;
    let segmentReasoning: ReasoningData | undefined;
    let suppressedText = '';

    for await (const chunk of stream) {
      const parsed = compat.parseStreamChunk(chunk);

      if (parsed.text) {
        if (requireToolCalls) {
          suppressedText += parsed.text;
        } else {
          followUpContent += parsed.text;
          yield {
            type: StreamEventType.DELTA,
            content: parsed.text
          };
        }
      }

      if (parsed.toolEvents) {
        for (const event of parsed.toolEvents) {
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

          yield {
            type: StreamEventType.TOOL,
            toolEvent: event
          };
        }
      }

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
        if (!segmentReasoning) {
          segmentReasoning = {
            text: parsed.reasoning.text,
            metadata: parsed.reasoning.metadata
          };
        } else {
          segmentReasoning.text += parsed.reasoning.text;
          if (parsed.reasoning.metadata) {
            segmentReasoning.metadata = {
              ...(segmentReasoning.metadata ?? {}),
              ...parsed.reasoning.metadata
            };
          }
        }

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

    const hasDetectedCalls = finishedWithToolCalls || detectedCallsById.size > 0 || pendingToolCalls.size > 0;
    if (!hasDetectedCalls || budget.exhausted) {
      if (requireToolCalls && !budget.exhausted && ignoredToolChoiceRetries < maxIgnoredToolChoiceRetries) {
        ignoredToolChoiceRetries += 1;

        const reminderLines: string[] = [
          'You MUST call the required tool now.',
          'Do NOT answer with any text.',
          'Return ONLY a tool call.'
        ];

        if (followUpToolChoice && typeof followUpToolChoice === 'object') {
          if (followUpToolChoice.type === 'single') {
            const apiName = followUpToolChoice.name;
            const displayName = toolNameMap[apiName] || apiName;
            reminderLines.splice(
              1,
              0,
              displayName === apiName
                ? `Call tool: ${displayName}`
                : `Call tool: ${displayName} (tool name: ${apiName})`
            );
          } else if (followUpToolChoice.type === 'required') {
            const allowed = Array.isArray(followUpToolChoice.allowed) ? followUpToolChoice.allowed : [];
            if (allowed.length > 0) {
              const display = allowed.map(name => toolNameMap[name] || name);
              reminderLines.splice(1, 0, `Allowed tools: ${display.join(', ')}`);
            }
          }
        }

        logger.warning?.('Tool choice was ignored; retrying tool call request', {
          provider: providerManifest.id,
          model,
          toolChoice: followUpToolChoice,
          retry: ignoredToolChoiceRetries,
          suppressedTextChars: suppressedText.length
        });

        messages.push({
          role: Role.USER,
          content: [{ type: 'text', text: reminderLines.join('\n') } as any]
        });
        continue;
      }

      break;
    }
    ignoredToolChoiceRetries = 0;

    // If we didn't receive TOOL_CALL_END events, finalize using pending state
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
    if (detectedCalls.length === 0) {
      break;
    }

    const preparedToolCalls: ToolCall[] = [];
    for (const call of detectedCalls) {
      const parsedArgs = safeJsonParse<Record<string, any>>(call.arguments, {}) as Record<string, any>;
      const originalName = toolNameMap[call.name || ''] || call.name || 'unknown';
      const finalToolCall: ToolCall = {
        id: call.id,
        name: originalName,
        arguments: parsedArgs,
        args: parsedArgs
      };
      if (call.metadata) {
        finalToolCall.metadata = call.metadata;
      }
      emittedToolCalls.push(finalToolCall);
      yield {
        type: 'tool_call' as any,
        toolCall: finalToolCall
      };

      const prepared: any = {
        id: call.id,
        name: call.name,
        arguments: parsedArgs
      };
      if (call.metadata) {
        prepared.metadata = call.metadata;
      }
      preparedToolCalls.push(prepared);
    }

    toolCallsToExecute = preparedToolCalls;
    toolCallReasoning = segmentReasoning;
  }

  if (!followUpContent && !latestUsage && !reasoningAggregate && emittedToolCalls.length === 0 && !terminalStop) {
    return undefined;
  }

  return {
    content: followUpContent || undefined,
    usage: latestUsage,
    reasoning: reasoningAggregate,
    toolCalls: emittedToolCalls.length > 0 ? emittedToolCalls : undefined,
    ...(terminalStop ? { finishReason: 'tool_stop' } : {})
  };
}
