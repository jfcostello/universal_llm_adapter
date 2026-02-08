import type { AdapterLogger, Message, ProviderManifest, ToolCall, UnifiedTool, ObservabilityContext } from '../../../../../kernel/index.js';

import { appendToolResult } from '../../../../messages/index.js';
import type { ToolCallBudget } from '../../tool-budget.js';
import { monotonicElapsedMs, monotonicNowNs } from '../../../../shared/index.js';
import { createProgressFields, resolveCountdownText, safeToolPayloadJson, safeToolPayloadText } from './utils.js';
import { isToolTerminalByDefinition, resolveCallArgTerminalOverride, resolveTerminalOverride, stripCallArgTerminalFlag } from './helpers.js';
import type { InvokeToolFn } from './types.js';
import { recordToolExecutionObservability, recordToolFailureSignal } from './observability.js';

type ExecuteToolCallResult =
  | {
      type: 'exhausted';
      toolName: string;
      toolCall: ToolCall;
      payload: any;
    }
  | {
      type: 'success';
      toolName: string;
      toolCall: ToolCall;
      payload: any;
      countdownText: string | undefined;
      terminal: boolean;
    }
  | {
      type: 'error';
      toolName: string;
      toolCall: ToolCall;
      payload: any;
      terminal: boolean;
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
  observability?: ObservabilityContext;
  generationId?: string;
  logger: AdapterLogger;
  messages: Message[];
  invokeTool: InvokeToolFn;
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
    const toolArgs = (toolCall as any)?.arguments ?? (toolCall as any)?.args;

    if (options.toolBudget.exhausted) {
      options.logger.info('Tool budget exhausted; skipping invocation', {
        toolName: targetToolName,
        callId: toolCall.id
      });
      const timestampMs = Date.now();
      recordToolExecutionObservability({
        observability: options.observability,
        logger: options.logger,
        generationId: options.generationId,
        provider: options.providerManifest.id,
        model: options.model,
        toolCallId: toolCall.id,
        toolName: targetToolName,
        timestampMs,
        args: toolArgs,
        result: {
          error: 'tool_call_budget_exhausted',
          message: 'No remaining tool calls are available for this run.',
          tool: targetToolName
        },
        skipped: true,
        skipReason: 'tool_call_budget_exhausted',
        maxResultLength: options.maxResultLength
      });
      recordToolFailureSignal({
        observability: options.observability,
        logger: options.logger,
        generationId: options.generationId,
        timestampMs,
        level: 'warning',
        code: 'tool_call_budget_exhausted',
        message: `Tool skipped due to budget exhaustion: ${targetToolName}`,
        toolCallId: toolCall.id,
        toolName: targetToolName,
        provider: options.providerManifest.id,
        model: options.model,
        skipReason: 'tool_call_budget_exhausted'
      });
      return {
        type: 'exhausted',
        toolName: targetToolName,
        toolCall,
        payload: {
          error: 'tool_call_budget_exhausted',
          message: 'No remaining tool calls are available for this run.',
          tool: targetToolName
        }
      };
    }

    if (!options.toolBudget.consume()) {
      options.logger.info('Tool budget consumption blocked invocation', {
        toolName: targetToolName,
        callId: toolCall.id
      });
      const timestampMs = Date.now();
      recordToolExecutionObservability({
        observability: options.observability,
        logger: options.logger,
        generationId: options.generationId,
        provider: options.providerManifest.id,
        model: options.model,
        toolCallId: toolCall.id,
        toolName: targetToolName,
        timestampMs,
        args: toolArgs,
        result: {
          error: 'tool_call_budget_exhausted',
          message: 'No remaining tool calls are available for this run.',
          tool: targetToolName
        },
        skipped: true,
        skipReason: 'tool_call_budget_exhausted',
        maxResultLength: options.maxResultLength
      });
      recordToolFailureSignal({
        observability: options.observability,
        logger: options.logger,
        generationId: options.generationId,
        timestampMs,
        level: 'warning',
        code: 'tool_call_budget_exhausted',
        message: `Tool skipped due to budget exhaustion: ${targetToolName}`,
        toolCallId: toolCall.id,
        toolName: targetToolName,
        provider: options.providerManifest.id,
        model: options.model,
        skipReason: 'tool_call_budget_exhausted'
      });
      return {
        type: 'exhausted',
        toolName: targetToolName,
        toolCall,
        payload: {
          error: 'tool_call_budget_exhausted',
          message: 'No remaining tool calls are available for this run.',
          tool: targetToolName
        }
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
    const startTimeMonoNs = monotonicNowNs();

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
      const timestampMs = Date.now();
      recordToolExecutionObservability({
        observability: options.observability,
        logger: options.logger,
        generationId: options.generationId,
        provider: options.providerManifest.id,
        model: options.model,
        toolCallId: toolCall.id,
        toolName: targetToolName,
        timestampMs,
        durationMs: monotonicElapsedMs(startTimeMonoNs),
        args: (invocationToolCall as any)?.arguments ?? (invocationToolCall as any)?.args,
        result: normalizedPayload,
        maxResultLength: options.maxResultLength
      });
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
        terminal: isTerminal
      };
    } catch (error: any) {
      options.logger.error?.('Tool execution failed', {
        ...logPayload,
        error: error?.message ?? String(error)
      });
      const timestampMs = Date.now();
      recordToolExecutionObservability({
        observability: options.observability,
        logger: options.logger,
        generationId: options.generationId,
        provider: options.providerManifest.id,
        model: options.model,
        toolCallId: toolCall.id,
        toolName: targetToolName,
        timestampMs,
        durationMs: monotonicElapsedMs(startTimeMonoNs),
        args: (toolCall as any)?.arguments ?? (toolCall as any)?.args,
        result: {
          error: 'tool_execution_failed',
          message: error?.message ?? String(error),
          tool: targetToolName
        },
        error: {
          message: error?.message ?? String(error),
          code: 'tool_execution_failed',
          ...(error && typeof error === 'object' && typeof error.stack === 'string' ? { stack: error.stack } : {})
        },
        maxResultLength: options.maxResultLength
      });
      recordToolFailureSignal({
        observability: options.observability,
        logger: options.logger,
        generationId: options.generationId,
        timestampMs,
        level: 'error',
        code: 'tool_execution_failed',
        message: `Tool execution failed: ${targetToolName}`,
        ...(error && typeof error === 'object' && typeof error.stack === 'string' ? { stack: error.stack } : {}),
        toolCallId: toolCall.id,
        toolName: targetToolName,
        provider: options.providerManifest.id,
        model: options.model
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
        terminal: callArgTerminalOverride !== undefined ? callArgTerminalOverride : terminalByDefinition
      };
    }
  };

  const processResult = (result: ExecuteToolCallResult) => {
    if (result.type === 'success') {
      toolResultsThisRound.push({ tool: result.toolName, result: result.payload });

      const rawText = safeToolPayloadText(result.payload);

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

      if (result.terminal) {
        terminalStopThisRound = true;
      }

      return;
    }

    toolResultsThisRound.push({ tool: result.toolName, result: result.payload });

    appendToolResult(
      options.messages,
      {
        toolName: result.toolName,
        callId: result.toolCall.id,
        result: result.payload,
        resultText: safeToolPayloadJson(result.payload)
      },
      {
        countdownText: resolveCountdownText(options.toolCountdownEnabled, options.toolBudget),
        maxLength: options.maxResultLength
      }
    );

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
