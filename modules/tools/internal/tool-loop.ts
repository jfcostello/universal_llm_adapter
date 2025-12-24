import type { PluginRegistry } from '../../kernel/index.js';
import {
  Role,
  StreamEventType,
  ToolCallEventType,
  getDefaults,
  safeJsonParse
} from '../../kernel/index.js';
import type {
  LLMResponse,
  LLMStreamEvent,
  Message,
  ProviderManifest,
  ToolCall,
  ToolChoice,
  UnifiedTool,
  RuntimeSettings,
  UsageStats,
  ReasoningData,
  AdapterLogger
} from '../../kernel/index.js';
import type { LLMManager } from '../../llm/index.js';
import { ToolCallBudget } from './tool-budget.js';
import { formatCountdown, buildFinalPrompt } from './tool-message.js';
import { appendAssistantToolCalls, appendToolResult } from '../../messages/index.js';
import { pruneReasoning, pruneToolResults } from '../../context/index.js';
import { sanitizeToolName } from './tool-names.js';
import { usageStatsToJson } from '../../usage/index.js';
import { normalizeFlag } from '../../shared/index.js';

interface BaseToolLoopOptions {
  llmManager: LLMManager;
  registry: PluginRegistry;
  messages: Message[];
  tools: UnifiedTool[];
  toolChoice?: ToolChoice;
  providerManifest: ProviderManifest;
  model: string;
  runtime: RuntimeSettings;
  providerSettings: Record<string, any>;
  providerExtras: Record<string, any>;
  logger: AdapterLogger;
  toolNameMap: Record<string, string>;
  runContext?: any;
  metadata?: Record<string, any>;
}

interface NonStreamToolLoopOptions extends BaseToolLoopOptions {
  mode: 'nonstream';
  initialResponse: LLMResponse;
  invokeTool: InvokeToolFn;
}

interface StreamToolLoopOptions extends BaseToolLoopOptions {
  mode: 'stream';
  initialToolCalls: ToolCall[];
  initialReasoning?: ReasoningData;
  invokeTool: InvokeToolFn;
}

type InvokeToolFn = (
  toolName: string,
  call: ToolCall,
  context: ToolInvocationContext
) => Promise<any>;

interface ToolInvocationContext {
  provider: string;
  model: string;
  metadata?: Record<string, any>;
  logger: AdapterLogger;
  callProgress?: Record<string, any>;
}

export function runToolLoop(options: NonStreamToolLoopOptions): Promise<LLMResponse>;
export function runToolLoop(options: StreamToolLoopOptions): AsyncGenerator<LLMStreamEvent, StreamLoopResult | undefined>;
export function runToolLoop(
  options: NonStreamToolLoopOptions | StreamToolLoopOptions
): Promise<LLMResponse> | AsyncGenerator<LLMStreamEvent, StreamLoopResult | undefined> {
  if (options.mode === 'nonstream') {
    return runNonStreamToolLoop(options);
  }
  return runStreamToolLoop(options);
}

function resolveFollowUpToolChoice(toolChoice?: ToolChoice): ToolChoice | undefined {
  // "required" is intended to ensure *at least one* tool call occurs.
  // After tools have been executed, relax to auto to avoid providers that interpret
  // "required" as "must keep calling tools".
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'required') {
    return 'auto';
  }
  return toolChoice;
}

async function runNonStreamToolLoop(options: NonStreamToolLoopOptions): Promise<LLMResponse> {
  const {
    llmManager,
    messages,
    tools,
    toolChoice,
    providerManifest,
    model,
    runtime,
    providerSettings,
    providerExtras,
    logger,
    runContext,
    toolNameMap,
    invokeTool,
    initialResponse,
    metadata
  } = options;

  const toolDefaults = getDefaults().tools;
  const toolCountdownEnabled = normalizeFlag(runtime.toolCountdownEnabled, toolDefaults.countdownEnabled);
  const toolFinalPromptEnabled = normalizeFlag(runtime.toolFinalPromptEnabled, toolDefaults.finalPromptEnabled);
  const parallelExecution = normalizeFlag(runtime.parallelToolExecution, toolDefaults.parallelExecution);
  const maxResultLength = typeof runtime.toolResultMaxChars === 'number' && runtime.toolResultMaxChars > 0
    ? Math.floor(runtime.toolResultMaxChars)
    : null;
  const maxToolIterations = parseMaxToolIterations(runtime.maxToolIterations, toolDefaults.maxIterations);
  const preserveToolResults = runtime.preserveToolResults ?? toolDefaults.preserveResults;
  const preserveReasoning = runtime.preserveReasoning ?? toolDefaults.preserveReasoning;

  const toolBudget = new ToolCallBudget(maxToolIterations);
  const allToolResults: Array<{ tool: string; result: any }> = [];
  const allToolCalls: ToolCall[] = [];

  let response = initialResponse;
  let forceFinalize = false;

  while (response.toolCalls && response.toolCalls.length > 0 && !forceFinalize) {
    logger.info('Tool calls detected', {
      provider: providerManifest.id,
      model,
      toolCalls: response.toolCalls.map(call => call.name)
    });

    const mappedToolCalls = response.toolCalls.map(call => ({
      ...call,
      name: toolNameMap[call.name] || call.name
    }));
    allToolCalls.push(...mappedToolCalls);

    appendAssistantToolCalls(
      messages,
      response.toolCalls,
      {
        sanitizeName: name => name,
        content: response.content,
        reasoning: response.reasoning
      }
    );

    const toolResultsThisRound: Array<{ tool: string; result: any }> = [];

    const executeToolCall = async (toolCall: ToolCall) => {
      const targetToolName = toolNameMap[toolCall.name] || toolCall.name;

      if (toolBudget.exhausted) {
        logger.info('Tool budget exhausted; skipping invocation', {
          toolName: targetToolName,
          callId: toolCall.id
        });
        return {
          type: 'exhausted' as const,
          toolName: targetToolName,
          toolCall,
          payload: {
            error: 'tool_call_budget_exhausted',
            message: 'No remaining tool calls are available for this run.',
            tool: targetToolName
          }
        };
      }

      if (!toolBudget.consume()) {
        logger.info('Tool budget consumption blocked invocation', {
          toolName: targetToolName,
          callId: toolCall.id
        });
        return {
          type: 'exhausted' as const,
          toolName: targetToolName,
          toolCall,
          payload: {
            error: 'tool_call_budget_exhausted',
            message: 'No remaining tool calls are available for this run.',
            tool: targetToolName
          }
        };
      }

      const progressFields = toolCountdownEnabled
        ? createProgressFields(toolBudget)
        : undefined;

      const logPayload = {
        toolName: targetToolName,
        callId: toolCall.id,
        ...(progressFields ?? {})
      };

      logger.info('Invoking tool', logPayload);

      try {
        const invocationResult = await invokeTool(
          targetToolName,
          toolCall,
          {
            provider: providerManifest.id,
            model,
            metadata,
            logger,
            callProgress: progressFields
          }
        );

        logger.info('Tool completed', logPayload);

        const normalizedPayload = invocationResult?.result !== undefined
          ? invocationResult.result
          : invocationResult;

        return {
          type: 'success' as const,
          toolName: targetToolName,
          toolCall,
          payload: normalizedPayload,
          countdownText: resolveCountdownText(toolCountdownEnabled, toolBudget)
        };
      } catch (error: any) {
        logger.error?.('Tool execution failed', {
          toolName: targetToolName,
          callId: toolCall.id,
          error: error?.message ?? String(error)
        });

        return {
          type: 'error' as const,
          toolName: targetToolName,
          toolCall,
          payload: {
            error: 'tool_execution_failed',
            message: error?.message ?? String(error),
            tool: targetToolName
          }
        };
      }
    };

    const processResult = (result: Awaited<ReturnType<typeof executeToolCall>>) => {
      if (result.type === 'success') {
        toolResultsThisRound.push({ tool: result.toolName, result: result.payload });

        const rawText = typeof result.payload === 'string'
          ? result.payload
          : JSON.stringify(result.payload);

        const truncatedText = maxResultLength && rawText.length > maxResultLength
          ? `${rawText.slice(0, maxResultLength)}…`
          : rawText;

        appendToolResult(
          messages,
          {
            toolName: result.toolName,
            callId: result.toolCall.id,
            result: result.payload,
            resultText: truncatedText
          },
          {
            countdownText: result.countdownText,
            maxLength: maxResultLength
          }
        );

        return;
      }

      toolResultsThisRound.push({ tool: result.toolName, result: result.payload });

      appendToolResult(
        messages,
        {
          toolName: result.toolName,
          callId: result.toolCall.id,
          result: result.payload,
          resultText: JSON.stringify(result.payload)
        },
        {
          countdownText: resolveCountdownText(toolCountdownEnabled, toolBudget),
          maxLength: maxResultLength
        }
      );

      if (result.type === 'exhausted') {
        forceFinalize = true;
      }
    };

    if (parallelExecution) {
      const results = await Promise.all(response.toolCalls.map(executeToolCall));
      for (const callResult of results) {
        processResult(callResult);
      }
    } else {
      for (const toolCall of response.toolCalls) {
        const callResult = await executeToolCall(toolCall);
        processResult(callResult);
        if (forceFinalize) {
          break;
        }
      }
    }

    allToolResults.push(...toolResultsThisRound);

    if (toolBudget.exhausted || forceFinalize) {
      break;
    }

    pruneToolResults(messages, preserveToolResults);
    pruneReasoning(messages, preserveReasoning);

    response = await llmManager.callProvider(
      providerManifest,
      model,
      providerSettings,
      messages,
      tools,
      resolveFollowUpToolChoice(toolChoice),
      providerExtras,
      logger,
      runContext
    );

    await maybeAttachUsageCost(response, providerManifest, model, providerSettings);
    logger.info('Follow-up provider response processed', {
      provider: providerManifest.id,
      model,
      finishReason: response.finishReason,
      toolCalls: response.toolCalls?.map(call => call.name) ?? [],
      usage: response.usage
        ? {
            promptTokens: response.usage.promptTokens,
            completionTokens: response.usage.completionTokens,
            reasoningTokens: response.usage.reasoningTokens,
            cachedTokens: response.usage.cachedTokens,
            cost: response.usage.cost,
            audioTokens: response.usage.audioTokens
          }
        : undefined
    });
  }

  if (toolBudget.maxCalls !== null && toolBudget.exhausted && toolFinalPromptEnabled) {
    const finalPrompt = buildFinalPrompt(toolBudget);

    messages.push({
      role: Role.USER,
      content: [{ type: 'text', text: finalPrompt }]
    });

    pruneToolResults(messages, preserveToolResults);
    pruneReasoning(messages, preserveReasoning);

    response = await llmManager.callProvider(
      providerManifest,
      model,
      providerSettings,
      messages,
      [],
      'none',
      providerExtras,
      logger,
      runContext
        ? { ...runContext, tools: [], mcpServers: [], toolNameMap: {} }
        : undefined
    );

    await maybeAttachUsageCost(response, providerManifest, model, providerSettings);
    logger.info('Final response requested after tool budget exhausted', {
      provider: providerManifest.id,
      model
    });
  }

  if (allToolCalls.length > 0) {
    response = {
      ...response,
      toolCalls: allToolCalls
    };
  }

  if (allToolResults.length > 0) {
    response.raw = {
      ...(response.raw as any ?? {}),
      toolResults: allToolResults
    };
  }

  return response;
}

interface StreamLoopResult {
  content?: string;
  usage?: UsageStats;
  reasoning?: ReasoningData;
  toolCalls?: ToolCall[];
}

async function* runStreamToolLoop(options: StreamToolLoopOptions): AsyncGenerator<LLMStreamEvent, StreamLoopResult | undefined> {
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

  const compat = await registry.getCompatModule(providerManifest.compat);
  const preserveToolResults = runtime.preserveToolResults ?? 3;
  const preserveReasoning = runtime.preserveReasoning ?? 3;

  const budget = new ToolCallBudget(parseMaxToolIterations(runtime.maxToolIterations));
  const toolCountdownEnabled = normalizeFlag(runtime.toolCountdownEnabled, true);
  const maxResultLength = typeof runtime.toolResultMaxChars === 'number' && runtime.toolResultMaxChars > 0
    ? Math.floor(runtime.toolResultMaxChars)
    : null;

  const emittedToolCalls: ToolCall[] = [];

  let followUpContent = '';
  let latestUsage: UsageStats | undefined;
  let reasoningAggregate: ReasoningData | undefined;

  let toolCallsToExecute: ToolCall[] = initialToolCalls;
  let toolCallReasoning: ReasoningData | undefined = initialReasoning;

  const appendAssistantCalls = (calls: ToolCall[], reasoning?: ReasoningData) => {
    const assistantToolCalls = calls.map(call => {
      const mapped: any = {
        id: call.id,
        name: sanitizeToolName(call.name ?? `tool_${call.id}`),
        arguments: call.arguments
      };
      // Preserve provider-specific metadata (e.g., signed/opaque fields required on follow-ups)
      if (call.metadata) {
        mapped.metadata = call.metadata;
      }
      return mapped;
    });

    appendAssistantToolCalls(messages, assistantToolCalls, {
      sanitizeName: name => name,
      reasoning
    });
  };

  while (true) {
    if (toolCallsToExecute.length > 0) {
      appendAssistantCalls(toolCallsToExecute, toolCallReasoning);

      for (const toolCall of toolCallsToExecute) {
        const sanitizedName = sanitizeToolName(toolCall.name ?? `tool_${toolCall.id}`);
        const directMatch = toolCall.name ? toolNameMap[toolCall.name] : undefined;
        const sanitizedMatch = toolNameMap[sanitizedName];
        const targetToolName = directMatch
          ?? sanitizedMatch
          ?? toolCall.name
          ?? 'unknown_tool';

        if (budget.exhausted) {
          const exhaustedPayload = {
            error: 'tool_call_budget_exhausted',
            message: 'No remaining tool calls are available for this run.',
            tool: targetToolName
          };

          appendToolResult(
            messages,
            {
              toolName: targetToolName,
              callId: toolCall.id,
              result: exhaustedPayload,
              resultText: JSON.stringify(exhaustedPayload)
            },
            {
              countdownText: resolveCountdownText(toolCountdownEnabled, budget),
              maxLength: maxResultLength
            }
          );
          continue;
        }

        const consumed = budget.consume();
        if (!consumed) {
          logger.info('Tool budget consumption blocked invocation', {
            toolName: targetToolName,
            callId: toolCall.id
          });
          break;
        }

        let progressFields: Record<string, any> | undefined;
        if (toolCountdownEnabled && budget.maxCalls !== null) {
          progressFields = createProgressFields(budget);
        }

        logger.info('Invoking tool', {
          toolName: targetToolName,
          callId: toolCall.id,
          ...(progressFields ?? {})
        });

        let normalizedPayload: any;
        try {
          const invocationResult = await invokeTool(
            targetToolName,
            toolCall,
            {
              provider: providerManifest.id,
              model,
              metadata,
              logger,
              callProgress: progressFields
            }
          );
          logger.info('Tool completed', {
            toolName: targetToolName,
            callId: toolCall.id,
            ...(progressFields ?? {})
          });
          normalizedPayload = invocationResult?.result !== undefined
            ? invocationResult.result
            : invocationResult;
        } catch (error: any) {
          const errorResult = {
            error: 'tool_execution_failed',
            message: error?.message ?? String(error)
          };
          normalizedPayload = errorResult;
        }

        const resultText = typeof normalizedPayload === 'string'
          ? normalizedPayload
          : JSON.stringify(normalizedPayload);

        const truncatedText = maxResultLength && resultText.length > maxResultLength
          ? `${resultText.slice(0, maxResultLength)}…`
          : resultText;

        appendToolResult(
          messages,
          {
            toolName: targetToolName,
            callId: toolCall.id,
            result: normalizedPayload,
            resultText: truncatedText
          },
          {
            countdownText: resolveCountdownText(toolCountdownEnabled, budget),
            maxLength: maxResultLength
          }
        );

        yield {
          type: StreamEventType.TOOL,
          toolEvent: {
            type: ToolCallEventType.TOOL_RESULT,
            callId: toolCall.id,
            name: targetToolName,
            arguments: JSON.stringify(normalizedPayload)
          }
        };
      }

      pruneToolResults(messages, preserveToolResults);
      pruneReasoning(messages, preserveReasoning);
    }

    const stream = llmManager.streamProvider(
      providerManifest,
      model,
      providerSettings,
      messages,
      budget.exhausted ? [] : tools,
      budget.exhausted ? 'none' : resolveFollowUpToolChoice(toolChoice),
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

    for await (const chunk of stream) {
      const parsed = compat.parseStreamChunk(chunk);

      if (parsed.text) {
        followUpContent += parsed.text;
        yield {
          type: StreamEventType.DELTA,
          content: parsed.text
        };
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
      break;
    }

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

  if (!followUpContent && !latestUsage && !reasoningAggregate && emittedToolCalls.length === 0) {
    return undefined;
  }

  return {
    content: followUpContent || undefined,
    usage: latestUsage,
    reasoning: reasoningAggregate,
    toolCalls: emittedToolCalls.length > 0 ? emittedToolCalls : undefined
  };
}

async function maybeAttachUsageCost(
  response: LLMResponse,
  providerManifest: ProviderManifest,
  model: string,
  providerSettings: Record<string, any>
): Promise<void> {
  if (!response?.usage) return;
  if (typeof response.usage.cost === 'number') return;

  const defaults = getDefaults();
  const enabled = normalizeFlag((providerSettings as any).usageCost, defaults.usageCost);
  if (!enabled) return;

  const { attachUsageCostIfMissing } = await import('../../usage-cost/index.js');
  attachUsageCostIfMissing({ usage: response.usage, provider: providerManifest.id, model });
}

function parseMaxToolIterations(value: unknown, defaultValue: number = 10): number {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : defaultValue;
  }
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : defaultValue;
}

function createProgressFields(budget: ToolCallBudget): Record<string, any> | undefined {
  if (budget.maxCalls === null) {
    return undefined;
  }

  const callNumber = budget.usedCalls;
  const totalCalls = budget.maxCalls;
  const remaining = budget.remaining;

  let progressLabel = `Tool call ${callNumber} of ${totalCalls}`;
  if (remaining !== null) {
    progressLabel += remaining === 0
      ? ' - No tool calls remaining'
      : ` - ${remaining} remaining`;
  }

  return {
    toolCallProgress: progressLabel,
    toolCallNumber: callNumber,
    toolCallTotal: totalCalls,
    toolCallsRemaining: remaining,
    finalToolCall: remaining === 0
  };
}

function resolveCountdownText(enabled: boolean, budget: ToolCallBudget): string | undefined {
  if (!enabled) {
    return undefined;
  }
  const countdown = formatCountdown(budget);
  return countdown ?? undefined;
}

export const __toolLoopTestUtils__ = {
  normalizeFlag,
  parseMaxToolIterations,
  createProgressFields,
  resolveCountdownText,
  maybeAttachUsageCost
};
