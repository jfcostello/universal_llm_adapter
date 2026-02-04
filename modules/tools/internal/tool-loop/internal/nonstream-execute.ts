import type { AdapterLogger, Message, ObservabilityContext, ProviderManifest, ToolCall, UnifiedTool } from '../../../../../kernel/index.js';

import { appendToolResult } from '../../../../messages/index.js';
import { sanitizeToolName } from '../../tool-names.js';
import type { ToolCallBudget } from '../../tool-budget.js';
import { createProgressFields, resolveCountdownText } from './utils.js';
import { isToolTerminalByDefinition, resolveCallArgTerminalOverride, resolveTerminalOverride, stripCallArgTerminalFlag } from './helpers.js';
import type { InvokeToolFn } from './types.js';
import { recordToolExecutionObservability } from './observability.js';

type ExecuteToolCallResult =
  | {
      type: 'exhausted';
      toolName: string;
      toolCall: ToolCall;
      payload: any;
      args: unknown;
      startTimeMs: number;
      endTimeMs: number;
    }
  | {
      type: 'success';
      toolName: string;
      toolCall: ToolCall;
      payload: any;
      countdownText: string | undefined;
      terminal: boolean;
      args: unknown;
      startTimeMs: number;
      endTimeMs: number;
    }
  | {
      type: 'error';
      toolName: string;
      toolCall: ToolCall;
      payload: any;
      terminal: boolean;
      args: unknown;
      startTimeMs: number;
      endTimeMs: number;
    };

export async function executeNonStreamToolCallsRound(options: {
  toolCalls: ToolCall[];
  toolNameMap: Record<string, string>;
  toolByName: Map<string, UnifiedTool>;
  toolBudget: ToolCallBudget;
  toolCountdownEnabled: boolean;
  parallelExecution: boolean;
  maxResultLength: number | null;
  providerManifest: ProviderManifest;
  model: string;
  metadata: Record<string, any> | undefined;
  logger: AdapterLogger;
  messages: Message[];
  invokeTool: InvokeToolFn;
  observability?: ObservabilityContext;
  generationId?: string;
}): Promise<{
  toolResultsThisRound: Array<{ tool: string; result: any }>;
  terminalStopThisRound: boolean;
  forceFinalize: boolean;
}> {
  const toolResultsThisRound: Array<{ tool: string; result: any }> = [];
  let terminalStopThisRound = false;
  let forceFinalize = false;

  const executeToolCall = async (toolCall: ToolCall): Promise<ExecuteToolCallResult> => {
    const targetToolName = options.toolNameMap[toolCall.name] || toolCall.name;
    const terminalByDefinition = isToolTerminalByDefinition(toolCall.name, options.toolByName);
    const callArgTerminalOverride = resolveCallArgTerminalOverride(toolCall, options.toolByName);

    if (options.toolBudget.exhausted) {
      options.logger.info('Tool budget exhausted; skipping invocation', {
        toolName: targetToolName,
        callId: toolCall.id
      });
      const now = Date.now();
      return {
        type: 'exhausted',
        toolName: targetToolName,
        toolCall,
        payload: {
          error: 'tool_call_budget_exhausted',
          message: 'No remaining tool calls are available for this run.',
          tool: targetToolName
        },
        args: toolCall.args ?? toolCall.arguments,
        startTimeMs: now,
        endTimeMs: now
      };
    }

    if (!options.toolBudget.consume()) {
      options.logger.info('Tool budget consumption blocked invocation', {
        toolName: targetToolName,
        callId: toolCall.id
      });
      const now = Date.now();
      return {
        type: 'exhausted',
        toolName: targetToolName,
        toolCall,
        payload: {
          error: 'tool_call_budget_exhausted',
          message: 'No remaining tool calls are available for this run.',
          tool: targetToolName
        },
        args: toolCall.args ?? toolCall.arguments,
        startTimeMs: now,
        endTimeMs: now
      };
    }

    const progressFields = options.toolCountdownEnabled
      ? createProgressFields(options.toolBudget)
      : undefined;

    const logPayload: Record<string, any> = {
      toolName: targetToolName,
      callId: toolCall.id,
      ...(progressFields ?? {})
    };

    options.logger.info('Invoking tool', logPayload);

    const startTimeMs = Date.now();
    try {
      const invocationToolCall = stripCallArgTerminalFlag(toolCall, options.toolByName);
      const invocationResult = await options.invokeTool(
        targetToolName,
        invocationToolCall,
        {
          provider: options.providerManifest.id,
          model: options.model,
          metadata: options.metadata,
          logger: options.logger,
          callProgress: logPayload
        }
      );

      options.logger.info('Tool completed', logPayload);

      const overrideTerminal = resolveTerminalOverride(invocationResult);
      const normalizedPayload = invocationResult?.result !== undefined
        ? invocationResult.result
        : invocationResult;
      const isTerminal = overrideTerminal !== undefined
        ? overrideTerminal
        : callArgTerminalOverride !== undefined
            ? callArgTerminalOverride
            : terminalByDefinition;

      return {
        type: 'success',
        toolName: targetToolName,
        toolCall,
        payload: normalizedPayload,
        countdownText: resolveCountdownText(options.toolCountdownEnabled, options.toolBudget),
        terminal: isTerminal,
        args: (invocationToolCall as any).args ?? invocationToolCall.arguments,
        startTimeMs,
        endTimeMs: Date.now()
      };
    } catch (error: any) {
      options.logger.error?.('Tool execution failed', {
        ...logPayload,
        error: error?.message ?? String(error)
      });

      return {
        type: 'error',
        toolName: targetToolName,
        toolCall,
        payload: {
          error: 'tool_execution_failed',
          message: error?.message ?? String(error),
          tool: targetToolName
        },
        terminal: callArgTerminalOverride !== undefined ? callArgTerminalOverride : terminalByDefinition,
        args: toolCall.args ?? toolCall.arguments,
        startTimeMs,
        endTimeMs: Date.now()
      };
    }
  };

  const processResult = (result: ExecuteToolCallResult) => {
    const record = (payload: { resultText: string; error?: { message: string; code?: string } }) => {
      recordToolExecutionObservability({
        observability: options.observability,
        logger: options.logger,
        metadata: options.metadata,
        generationId: options.generationId,
        provider: options.providerManifest.id,
        model: options.model,
        toolCallId: result.toolCall.id,
        toolName: result.toolName,
        args: result.args,
        result: result.payload,
        resultText: payload.resultText,
        ...(payload.error ? { error: payload.error } : {}),
        startTimeMs: result.startTimeMs,
        endTimeMs: result.endTimeMs
      });
    };

    if (result.type === 'success') {
      toolResultsThisRound.push({ tool: result.toolName, result: result.payload });

      const rawText = typeof result.payload === 'string'
        ? result.payload
        : JSON.stringify(result.payload);

      const truncatedText = options.maxResultLength && rawText.length > options.maxResultLength
        ? `${rawText.slice(0, options.maxResultLength)}…`
        : rawText;

      appendToolResult(
        options.messages,
        {
          toolName: result.toolName,
          callId: result.toolCall.id,
          result: result.payload,
          resultText: truncatedText
        },
        {
          countdownText: result.countdownText,
          maxLength: options.maxResultLength
        }
      );

      record({ resultText: truncatedText });

      if (result.terminal) {
        terminalStopThisRound = true;
      }

      return;
    }

    toolResultsThisRound.push({ tool: result.toolName, result: result.payload });

    const resultText = JSON.stringify(result.payload);
    appendToolResult(
      options.messages,
      {
        toolName: result.toolName,
        callId: result.toolCall.id,
        result: result.payload,
        resultText
      },
      {
        countdownText: resolveCountdownText(options.toolCountdownEnabled, options.toolBudget),
        maxLength: options.maxResultLength
      }
    );

    const payload = result.payload as any;
    record({
      resultText,
      error: {
        message: String(payload?.message),
        code: String(payload?.error)
      }
    });

    if (result.type === 'exhausted') {
      forceFinalize = true;
      return;
    }

    if (result.terminal) {
      terminalStopThisRound = true;
    }
  };

  if (options.parallelExecution) {
    const results = await Promise.all(options.toolCalls.map(executeToolCall));
    for (const callResult of results) {
      processResult(callResult);
    }
  } else {
    for (const toolCall of options.toolCalls) {
      const callResult = await executeToolCall(toolCall);
      processResult(callResult);
      if (forceFinalize) {
        break;
      }
    }
  }

  return {
    toolResultsThisRound,
    terminalStopThisRound,
    forceFinalize
  };
}
