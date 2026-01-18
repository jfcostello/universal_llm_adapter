import { StreamEventType, ToolCallEventType } from '../../../../../kernel/index.js';
import type { AdapterLogger, LLMStreamEvent, Message, ProviderManifest, ReasoningData, ToolCall, UnifiedTool } from '../../../../../kernel/index.js';

import { ToolCallBudget } from '../../tool-budget.js';
import { appendAssistantToolCalls, appendToolResult } from '../../../../messages/index.js';
import { pruneReasoning, pruneToolResults } from '../../../../context/index.js';
import { sanitizeToolName } from '../../tool-names.js';

import { createProgressFields, resolveCountdownText } from './utils.js';
import { isToolTerminalByDefinition, resolveTerminalOverride } from './helpers.js';
import type { InvokeToolFn } from './types.js';

export async function* executeStreamToolCallsRound(options: {
  toolCallsToExecute: ToolCall[];
  toolCallReasoning: ReasoningData | undefined;
  messages: Message[];
  tools: UnifiedTool[];
  toolNameMap: Record<string, string>;
  toolByName: Map<string, UnifiedTool>;
  budget: ToolCallBudget;
  toolCountdownEnabled: boolean;
  maxResultLength: number | null;
  providerManifest: ProviderManifest;
  model: string;
  metadata: Record<string, any> | undefined;
  logger: AdapterLogger;
  invokeTool: InvokeToolFn;
  calledToolNames: Set<string>;
  preserveToolResults: number | 'all' | 'none';
  preserveReasoning: number | 'all' | 'none';
}): AsyncGenerator<LLMStreamEvent, { terminalStopThisRound: boolean }> {
  if (options.toolCallsToExecute.length === 0) {
    return { terminalStopThisRound: false };
  }

  for (const call of options.toolCallsToExecute) {
    const name = typeof call?.name === 'string' ? call.name : '';
    if (!name) continue;
    options.calledToolNames.add(name);
    options.calledToolNames.add(sanitizeToolName(name));
  }

  const assistantToolCalls = options.toolCallsToExecute.map(call => {
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

  appendAssistantToolCalls(options.messages, assistantToolCalls, {
    sanitizeName: name => name,
    reasoning: options.toolCallReasoning
  });

  let terminalStopThisRound = false;

  for (const toolCall of options.toolCallsToExecute) {
    const sanitizedName = sanitizeToolName(toolCall.name ?? `tool_${toolCall.id}`);
    const directMatch = toolCall.name ? options.toolNameMap[toolCall.name] : undefined;
    const sanitizedMatch = options.toolNameMap[sanitizedName];
    const targetToolName = directMatch
      ?? sanitizedMatch
      ?? toolCall.name
      ?? 'unknown_tool';
    const definitionName = toolCall.name ?? sanitizedName;
    const terminalByDefinition = isToolTerminalByDefinition(definitionName, options.toolByName);

    if (options.budget.exhausted) {
      const exhaustedPayload = {
        error: 'tool_call_budget_exhausted',
        message: 'No remaining tool calls are available for this run.',
        tool: targetToolName
      };

      appendToolResult(
        options.messages,
        {
          toolName: targetToolName,
          callId: toolCall.id,
          result: exhaustedPayload,
          resultText: JSON.stringify(exhaustedPayload)
        },
        {
          countdownText: resolveCountdownText(options.toolCountdownEnabled, options.budget),
          maxLength: options.maxResultLength
        }
      );
      continue;
    }

    const consumed = options.budget.consume();
    if (!consumed) {
      options.logger.info('Tool budget consumption blocked invocation', {
        toolName: targetToolName,
        callId: toolCall.id
      });
      break;
    }

    let progressFields: Record<string, any> | undefined;
    if (options.toolCountdownEnabled && options.budget.maxCalls !== null) {
      progressFields = createProgressFields(options.budget);
    }

    options.logger.info('Invoking tool', {
      toolName: targetToolName,
      callId: toolCall.id,
      ...(progressFields ?? {})
    });

    let normalizedPayload: any;
    let overrideTerminal: boolean | undefined;
    try {
      const invocationResult = await options.invokeTool(
        targetToolName,
        toolCall,
        {
          provider: options.providerManifest.id,
          model: options.model,
          metadata: options.metadata,
          logger: options.logger,
          callProgress: progressFields
        }
      );
      options.logger.info('Tool completed', {
        toolName: targetToolName,
        callId: toolCall.id,
        ...(progressFields ?? {})
      });
      overrideTerminal = resolveTerminalOverride(invocationResult);
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

    const isTerminal = overrideTerminal !== undefined
      ? overrideTerminal
      : terminalByDefinition;
    if (isTerminal) {
      terminalStopThisRound = true;
    }

    const resultText = typeof normalizedPayload === 'string'
      ? normalizedPayload
      : JSON.stringify(normalizedPayload);

    const truncatedText = options.maxResultLength && resultText.length > options.maxResultLength
      ? `${resultText.slice(0, options.maxResultLength)}…`
      : resultText;

    appendToolResult(
      options.messages,
      {
        toolName: targetToolName,
        callId: toolCall.id,
        result: normalizedPayload,
        resultText: truncatedText
      },
      {
        countdownText: resolveCountdownText(options.toolCountdownEnabled, options.budget),
        maxLength: options.maxResultLength
      }
    );

    yield {
      type: StreamEventType.TOOL,
      toolEvent: {
        type: ToolCallEventType.TOOL_RESULT,
        callId: toolCall.id,
        name: targetToolName,
        arguments: JSON.stringify(normalizedPayload),
        resultText: truncatedText
      }
    } as any;
  }

  pruneToolResults(options.messages, options.preserveToolResults);
  pruneReasoning(options.messages, options.preserveReasoning);

  return { terminalStopThisRound };
}
