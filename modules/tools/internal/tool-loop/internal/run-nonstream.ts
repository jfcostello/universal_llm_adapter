import type { PluginRegistry } from '../../../../../kernel/index.js';
import { Role, getDefaults } from '../../../../../kernel/index.js';
import type {
  LLMResponse,
  Message,
  ProviderManifest,
  ToolCall,
  ToolChoice,
  UnifiedTool,
  RuntimeSettings,
  AdapterLogger
} from '../../../../../kernel/index.js';

import type { LLMManager } from '../../../../llm/index.js';
import { ToolCallBudget } from '../../tool-budget.js';
import { buildFinalPrompt } from '../../tool-message.js';
import { appendAssistantToolCalls } from '../../../../messages/index.js';
import { pruneReasoning, pruneToolResults } from '../../../../context/index.js';
import { sanitizeToolName } from '../../tool-names.js';
import { normalizeFlag } from '../../../../shared/index.js';

import { executeNonStreamToolCallsRound } from './nonstream-execute.js';
import { resolveFollowUpToolChoice } from './helpers.js';
import { maybeAttachUsageCost, parseMaxToolIterations } from './utils.js';
import type { NonStreamToolLoopOptions } from './types.js';

export async function runNonStreamToolLoop(options: NonStreamToolLoopOptions): Promise<LLMResponse> {
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
  const toolByName = new Map<string, UnifiedTool>(tools.map(tool => [tool.name, tool]));
  const allToolResults: Array<{ tool: string; result: any }> = [];
  const allToolCalls: ToolCall[] = [];
  const calledToolNames = new Set<string>();

  let response = initialResponse;
  let forceFinalize = false;
  let terminalStop = false;
  const maxIgnoredToolChoiceRetries = 3;
  let ignoredToolChoiceRetries = 0;

  const requireToolCalls = tools.length > 0 &&
    toolChoice !== undefined &&
    toolChoice !== 'auto' &&
    toolChoice !== 'none';

  while (requireToolCalls &&
    (!response.toolCalls || response.toolCalls.length === 0) &&
    ignoredToolChoiceRetries < maxIgnoredToolChoiceRetries) {
    ignoredToolChoiceRetries += 1;

    const reminderLines: string[] = [
      'You MUST call the required tool now.',
      'Do NOT answer with any text.',
      'Return ONLY a tool call.'
    ];

    if (toolChoice && typeof toolChoice === 'object') {
      if (toolChoice.type === 'single') {
        const apiName = toolChoice.name;
        const displayName = toolNameMap[apiName] || apiName;
        reminderLines.splice(
          1,
          0,
          displayName === apiName
            ? `Call tool: ${displayName}`
            : `Call tool: ${displayName} (tool name: ${apiName})`
        );
      } else if (toolChoice.type === 'required') {
        const allowed = Array.isArray(toolChoice.allowed) ? toolChoice.allowed : [];
        if (allowed.length === 1) {
          const apiName = allowed[0];
          const displayName = toolNameMap[apiName] || apiName;
          reminderLines.splice(
            1,
            0,
            displayName === apiName
              ? `Call tool: ${displayName}`
              : `Call tool: ${displayName} (tool name: ${apiName})`
          );
        } else if (allowed.length > 0) {
          const display = allowed.map(name => toolNameMap[name] || name);
          reminderLines.splice(1, 0, `Allowed tools: ${display.join(', ')}`);
        }
      }
    }

    logger.warning?.('Tool choice was ignored; retrying tool call request', {
      provider: providerManifest.id,
      model,
      toolChoice,
      retry: ignoredToolChoiceRetries
    });

    messages.push({
      role: Role.USER,
      content: [{ type: 'text', text: reminderLines.join('\n') } as any]
    });

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

    await maybeAttachUsageCost(response, providerManifest, model, providerSettings);
  }

  while (response.toolCalls && response.toolCalls.length > 0 && !forceFinalize) {
    for (const call of response.toolCalls) {
      calledToolNames.add(call.name);
      calledToolNames.add(sanitizeToolName(call.name));
    }

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

    const round = await executeNonStreamToolCallsRound({
      toolCalls: response.toolCalls,
      toolNameMap,
      toolByName,
      toolBudget,
      toolCountdownEnabled,
      parallelExecution,
      maxResultLength,
      providerManifest,
      model,
      metadata,
      logger,
      messages,
      invokeTool
    });

    allToolResults.push(...round.toolResultsThisRound);
    forceFinalize = forceFinalize || round.forceFinalize;

    if (round.terminalStopThisRound) {
      terminalStop = true;
      break;
    }

    if (toolBudget.exhausted || forceFinalize) {
      break;
    }

    pruneToolResults(messages, preserveToolResults);
    pruneReasoning(messages, preserveReasoning);

    const followUpRunContext = runContext
      ? { ...runContext, toolCallsSoFar: allToolCalls }
      : { toolCallsSoFar: allToolCalls };

    response = await llmManager.callProvider(
      providerManifest,
      model,
      providerSettings,
      messages,
      tools,
      resolveFollowUpToolChoice(toolChoice, calledToolNames),
      providerExtras,
      logger,
      followUpRunContext
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

  if (!terminalStop && toolBudget.maxCalls !== null && toolBudget.exhausted && toolFinalPromptEnabled) {
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
        ? { ...runContext, tools: [], mcpServers: [], toolNameMap: {}, toolCallsSoFar: allToolCalls }
        : { tools: [], mcpServers: [], toolNameMap: {}, toolCallsSoFar: allToolCalls }
    );

    await maybeAttachUsageCost(response, providerManifest, model, providerSettings);
    logger.info('Final response requested after tool budget exhausted', {
      provider: providerManifest.id,
      model
    });
  }

  if (terminalStop) {
    response = {
      ...response,
      finishReason: 'tool_stop'
    };
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
