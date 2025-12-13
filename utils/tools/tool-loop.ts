import { PluginRegistry } from '../../core/registry.js';
import {
  AdapterLogger
} from '../../core/logging.js';
import {
  LLMResponse,
  LLMStreamEvent,
  Message,
  ProviderManifest,
  Role,
  StreamEventType,
  ToolCall,
  ToolCallEventType,
  ToolChoice,
  UnifiedTool,
  RuntimeSettings,
  UsageStats,
  ReasoningData
} from '../../core/types.js';
import { LLMManager } from '../../managers/llm-manager.js';
import { ToolCallBudget } from './tool-budget.js';
import { formatCountdown, buildFinalPrompt } from './tool-message.js';
import { appendAssistantToolCalls, appendToolResult } from '../messages/message-utils.js';
import { pruneReasoning, pruneToolResults } from '../context/context-manager.js';
import { sanitizeToolName } from './tool-names.js';
import { usageStatsToJson } from '../usage/usage-utils.js';
import { getDefaults } from '../../core/defaults.js';

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
        logger.error('Tool execution failed', {
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
      toolChoice,
      providerExtras,
      logger,
      runContext
    );

    logger.info('Follow-up provider response processed', {
      provider: providerManifest.id,
      model,
      finishReason: response.finishReason,
      toolCalls: response.toolCalls?.map(call => call.name) ?? [],
      usage: response.usage
        ? {
            promptTokens: response.usage.promptTokens,
            completionTokens: response.usage.completionTokens,
            reasoningTokens: response.usage.reasoningTokens
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
    metadata
  } = options;

  const compat = await registry.getCompatModule(providerManifest.compat);
  const preserveToolResults = runtime.preserveToolResults ?? 3;
  const preserveReasoning = runtime.preserveReasoning ?? 3;

  const budget = new ToolCallBudget(parseMaxToolIterations(runtime.maxToolIterations));
  const toolCountdownEnabled = normalizeFlag(runtime.toolCountdownEnabled, true);
  const maxResultLength = typeof runtime.toolResultMaxChars === 'number' && runtime.toolResultMaxChars > 0
    ? Math.floor(runtime.toolResultMaxChars)
    : null;

  const assistantToolCalls = initialToolCalls.map(call => {
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
    reasoning: initialReasoning
  });

  for (const toolCall of initialToolCalls) {
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
      const callNumber = budget.usedCalls;
      const totalCalls = budget.maxCalls;
      const remaining = budget.remaining;

      let progressLabel = `Tool call ${callNumber} of ${totalCalls}`;
      if (remaining !== null) {
        progressLabel += remaining === 0 ? ' - No tool calls remaining' : ` - ${remaining} remaining`;
      }

      progressFields = {
        toolCallProgress: progressLabel,
        toolCallNumber: callNumber,
        toolCallTotal: totalCalls,
        toolCallsRemaining: remaining,
        finalToolCall: remaining === 0
      };
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
      let errorMessage: string;
      if (error && error.message) {
        errorMessage = error.message;
      } else {
        errorMessage = String(error);
      }
      const errorResult = {
        error: 'tool_execution_failed',
        message: errorMessage
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

  const stream = llmManager.streamProvider(
    providerManifest,
    model,
    providerSettings,
    messages,
    budget.exhausted ? [] : tools,
    budget.exhausted ? 'none' : toolChoice,
    providerExtras,
    logger
  );

  let followUpContent = '';
  let latestUsage: UsageStats | undefined;
  let reasoningAggregate: ReasoningData | undefined;

  for await (const chunk of stream) {
    const parsed = compat.parseStreamChunk(chunk);

    if (parsed.text) {
      followUpContent += parsed.text;
      yield {
        type: StreamEventType.DELTA,
        content: parsed.text
      };
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

  if (!followUpContent && !latestUsage && !reasoningAggregate) {
    return undefined;
  }

  return {
    content: followUpContent || undefined,
    usage: latestUsage,
    reasoning: reasoningAggregate
  };
}

function normalizeFlag(value: unknown, defaultValue: boolean): boolean {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Boolean(value);
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return defaultValue;
  }
  return Boolean(value);
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
  resolveCountdownText
};
