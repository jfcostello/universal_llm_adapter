import { StreamEventType, ToolCallEventType } from '../../../../../kernel/index.js';
import type {
  AdapterLogger,
  LLMStreamEvent,
  Message,
  ObservabilityContext,
  ProviderManifest,
  ToolCall,
  UnifiedTool
} from '../../../../../kernel/index.js';
import type { ToolCallBudget } from '../../tool-budget.js';
import { appendToolResult } from '../../../../messages/index.js';
import { sanitizeToolName } from '../../tool-names.js';
import { monotonicElapsedMs, monotonicNowNs } from '../../../../shared/index.js';
import { createProgressFields, resolveCountdownText, safeToolPayloadJson, safeToolPayloadText } from './utils.js';
import {
  isToolTerminalByDefinition,
  resolveCallArgTerminalOverride,
  resolveTerminalOverride,
  stripCallArgTerminalFlag
} from './helpers.js';
import type { InvokeToolFn } from './types.js';
import { recordToolExecutionObservability, recordToolFailureSignal } from './observability.js';
type ToolCallSlot =
  | {
      type: 'skipped';
      toolCall: ToolCall;
      toolName: string;
      payload: any;
      countdownText: string | undefined;
    }
  | {
      type: 'executed';
      toolCall: ToolCall;
      toolName: string;
      countdownText: string | undefined;
      payload?: any;
      truncatedText?: string;
      terminal?: boolean;
    };

type PendingToolResult = {
  index: number;
  callId: string;
  toolName: string;
  payload: any;
  truncatedText: string;
  terminal: boolean;
};

export async function* executeStreamToolCallsRoundParallel(options: {
  toolCallsToExecute: ToolCall[];
  messages: Message[];
  toolNameMap: Record<string, string>;
  toolByName: Map<string, UnifiedTool>;
  budget: ToolCallBudget;
  toolCountdownEnabled: boolean;
  maxResultLength: number | null;
  providerManifest: ProviderManifest;
  model: string;
  metadata: Record<string, any> | undefined;
  observability?: ObservabilityContext;
  generationId?: string;
  logger: AdapterLogger;
  invokeTool: InvokeToolFn;
}): AsyncGenerator<LLMStreamEvent, { terminalStopThisRound: boolean }> {
  const slots: ToolCallSlot[] = [];
  const pending = new Set<Promise<{ task: Promise<any>; result: PendingToolResult }>>();

  const startExecutionForSlot = (slotIndex: number, planned: ToolCallSlot & { type: 'executed' }) => {
    let task: Promise<{ task: Promise<any>; result: PendingToolResult }>;

    const base = (async (): Promise<PendingToolResult> => {
      const toolCall = planned.toolCall;
      const targetToolName = planned.toolName;
      const sanitizedName = sanitizeToolName(toolCall.name ?? `tool_${toolCall.id}`);
      const definitionName = toolCall.name ?? sanitizedName;
      const terminalByDefinition = isToolTerminalByDefinition(definitionName, options.toolByName);
      const callArgTerminalOverride = resolveCallArgTerminalOverride(
        { ...toolCall, name: definitionName } as any,
        options.toolByName
      );
      const toolArgs = (toolCall as any)?.arguments ?? (toolCall as any)?.args;

      let progressFields: Record<string, any> | undefined;
      if (options.toolCountdownEnabled && options.budget.maxCalls !== null) {
        progressFields = createProgressFields(options.budget);
      }

      const logPayload: Record<string, any> = {
        toolName: targetToolName,
        callId: toolCall.id,
        ...(progressFields ?? {})
      };

      options.logger.info('Invoking tool', logPayload);
      const startTimeMonoNs = monotonicNowNs();

      let normalizedPayload: any;
      let overrideTerminal: boolean | undefined;
      let executionError: any;
      let invocationToolCall: any;

      try {
        const stripped = stripCallArgTerminalFlag(
          { ...toolCall, name: definitionName } as any,
          options.toolByName
        );
        invocationToolCall = {
          ...toolCall,
          arguments: stripped.arguments,
          args: (stripped as any).args ?? stripped.arguments
        };

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

        overrideTerminal = resolveTerminalOverride(invocationResult);
        normalizedPayload = invocationResult?.result !== undefined
          ? invocationResult.result
          : invocationResult;
      } catch (error: any) {
        executionError = error;
        options.logger.error?.('Tool execution failed', {
          ...logPayload,
          error: error?.message ?? String(error)
        });
        normalizedPayload = {
          error: 'tool_execution_failed',
          message: error?.message ?? String(error)
        };
      }

      const isTerminal = overrideTerminal !== undefined
        ? overrideTerminal
        : callArgTerminalOverride !== undefined
            ? callArgTerminalOverride
            : terminalByDefinition;

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
        args: (invocationToolCall as any)?.arguments ?? (invocationToolCall as any)?.args ?? toolArgs,
        result: normalizedPayload,
        ...(executionError
          ? {
              error: {
                message: executionError?.message ?? String(executionError),
                code: 'tool_execution_failed',
                ...(executionError && typeof executionError === 'object' && typeof executionError.stack === 'string'
                  ? { stack: executionError.stack }
                  : {})
              }
            }
          : {}),
        maxResultLength: options.maxResultLength
      });

      if (executionError) {
        recordToolFailureSignal({
          observability: options.observability,
          logger: options.logger,
          generationId: options.generationId,
          timestampMs,
          level: 'error',
          code: 'tool_execution_failed',
          message: `Tool execution failed: ${targetToolName}`,
          ...(executionError && typeof executionError === 'object' && typeof executionError.stack === 'string'
            ? { stack: executionError.stack }
            : {}),
          toolCallId: toolCall.id,
          toolName: targetToolName,
          provider: options.providerManifest.id,
          model: options.model
        });
      }

      const resultText = safeToolPayloadText(normalizedPayload);

      const truncatedText = options.maxResultLength && resultText.length > options.maxResultLength
        ? `${resultText.slice(0, options.maxResultLength)}…`
        : resultText;

      planned.payload = normalizedPayload;
      planned.truncatedText = truncatedText;
      planned.terminal = isTerminal;

      return {
        index: slotIndex,
        callId: toolCall.id,
        toolName: targetToolName,
        payload: normalizedPayload,
        truncatedText,
        terminal: isTerminal
      };
    })();

    task = base.then(result => ({ task, result }));
    pending.add(task);
  };

  for (const toolCall of options.toolCallsToExecute) {
    const sanitizedName = sanitizeToolName(toolCall.name ?? `tool_${toolCall.id}`);
    const directMatch = toolCall.name ? options.toolNameMap[toolCall.name] : undefined;
    const sanitizedMatch = options.toolNameMap[sanitizedName];
    const targetToolName = directMatch
      ?? sanitizedMatch
      ?? toolCall.name
      ?? 'unknown_tool';
    const toolArgs = (toolCall as any)?.arguments ?? (toolCall as any)?.args;
    const exhaustedPayload = {
      error: 'tool_call_budget_exhausted',
      message: 'No remaining tool calls are available for this run.',
      tool: targetToolName
    };

    if (options.budget.exhausted) {
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
        result: exhaustedPayload,
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

      slots.push({
        type: 'skipped',
        toolCall,
        toolName: targetToolName,
        payload: exhaustedPayload,
        countdownText: resolveCountdownText(options.toolCountdownEnabled, options.budget)
      });
      continue;
    }

    const consumed = options.budget.consume();
    if (!consumed) {
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
        result: exhaustedPayload,
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

      slots.push({
        type: 'skipped',
        toolCall,
        toolName: targetToolName,
        payload: exhaustedPayload,
        countdownText: resolveCountdownText(options.toolCountdownEnabled, options.budget)
      });
      break;
    }

    const slotIndex = slots.length;
    const executed: ToolCallSlot & { type: 'executed' } = {
      type: 'executed',
      toolCall,
      toolName: targetToolName,
      countdownText: resolveCountdownText(options.toolCountdownEnabled, options.budget)
    };
    slots.push(executed);
    startExecutionForSlot(slotIndex, executed);
  }

  let terminalStopThisRound = false;
  while (pending.size > 0) {
    const { task, result } = await Promise.race(pending);
    pending.delete(task);

    if (result.terminal) {
      terminalStopThisRound = true;
    }

    yield {
      type: StreamEventType.TOOL,
      toolEvent: {
        type: ToolCallEventType.TOOL_RESULT,
        callId: result.callId,
        name: result.toolName,
        arguments: safeToolPayloadJson(result.payload),
        resultText: result.truncatedText
      }
    } as any;
  }

  for (const slot of slots) {
    if (slot.type === 'skipped') {
      appendToolResult(
        options.messages,
        {
          toolName: slot.toolName,
          callId: slot.toolCall.id,
          result: slot.payload,
          resultText: safeToolPayloadJson(slot.payload)
        },
        {
          countdownText: slot.countdownText,
          maxLength: options.maxResultLength
        }
      );
      continue;
    }

    appendToolResult(
      options.messages,
      {
        toolName: slot.toolName,
        callId: slot.toolCall.id,
        result: slot.payload,
        resultText: slot.truncatedText
      },
      {
        countdownText: slot.countdownText,
        maxLength: options.maxResultLength
      }
    );
  }

  return { terminalStopThisRound };
}
