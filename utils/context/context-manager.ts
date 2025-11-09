import { Message, Role, ToolResultContent, ContentPart, TextContent, ImageContent } from '../../core/types.js';

export const TOOL_REDACTION_PLACEHOLDER =
  'This is a placeholder, not the original tool response; the tool output has been redacted to save context.';
export const TOOL_REDACTION_REASON = 'context_pruning';

function isRedactedToolContent(content: ContentPart[]): boolean {
  return content.some(
    part =>
      part.type === 'tool_result' &&
      typeof part.result === 'object' &&
      part.result !== null &&
      'redacted' in part.result &&
      (part.result as any).redacted === true &&
      (part.result as any).reason === TOOL_REDACTION_REASON
  );
}

function createRedactedToolContent(content: ContentPart[]): ContentPart[] {
  const existingToolResult = content.find(
    (part): part is ToolResultContent => part.type === 'tool_result'
  );

  const toolName = existingToolResult?.toolName ?? 'unknown_tool';

  return [
    { type: 'text', text: TOOL_REDACTION_PLACEHOLDER },
    {
      type: 'tool_result',
      toolName,
      result: {
        redacted: true,
        reason: TOOL_REDACTION_REASON
      }
    }
  ];
}

/**
 * Configuration for tool result preservation in conversation history.
 * - number: Preserve the last N tool-calling cycles
 * - 'all': Preserve all tool results (default behavior, no pruning)
 * - 'none': Don't preserve any tool results after immediate use
 */
export type ToolResultPreservation = number | 'all' | 'none';

/**
 * Configuration for reasoning preservation in conversation history.
 * - number: Preserve the last N assistant messages with reasoning
 * - 'all': Preserve all reasoning (default behavior, no pruning)
 * - 'none': Don't preserve any reasoning after immediate use
 */
export type ReasoningPreservation = number | 'all' | 'none';

/**
 * Represents a tool-calling cycle: an assistant message with tool calls
 * and its associated tool result messages.
 */
interface ToolCallCycle {
  assistantMessageIndex: number;
  toolResultIndices: number[];
}

/**
 * Prunes old tool result messages from the conversation history based on preservation settings.
 *
 * This function works with normalized Message[] arrays (post-compat parsing) and only removes
 * messages with role === Role.TOOL. It preserves all assistant, user, and system messages.
 *
 * A "cycle" is defined as:
 * - One assistant message with toolCalls property
 * - All associated tool result messages (role === TOOL with matching toolCallId)
 *
 * @param messages - The message array to prune (modified in-place)
 * @param preserveCount - How many cycles to preserve ('all', 'none', or a number)
 *
 * @example
 * // Preserve all tool results (default - no pruning)
 * pruneToolResults(messages, 'all');
 *
 * @example
 * // Preserve last 3 tool-calling cycles
 * pruneToolResults(messages, 3);
 *
 * @example
 * // Don't preserve any tool results
 * pruneToolResults(messages, 'none');
 */
export function pruneToolResults(
  messages: Message[],
  preserveCount: ToolResultPreservation = 'all'
): void {

  // Early return if no pruning needed
  if (preserveCount === 'all') {
    return;
  }

  // Identify all tool-calling cycles
  const cycles = identifyToolCallCycles(messages);

  if (cycles.length === 0) {
    return; // No tool calls to prune
  }

  // Determine which tool result indices to remove
  const indicesToRemove = new Set<number>();

  if (preserveCount === 'none') {
    // Remove all tool results
    for (const cycle of cycles) {
      for (const index of cycle.toolResultIndices) {
        indicesToRemove.add(index);
      }
    }
  } else {
    // Preserve last N cycles, remove older ones
    const cyclesToRemove = cycles.length - preserveCount;
    if (cyclesToRemove > 0) {
      for (let i = 0; i < cyclesToRemove; i++) {
        for (const index of cycles[i].toolResultIndices) {
          indicesToRemove.add(index);
        }
      }
    }
  }

  for (const index of indicesToRemove) {
    const message = messages[index];
    if (!message || message.role !== Role.TOOL) {
      continue;
    }

    if (isRedactedToolContent(message.content)) {
      continue;
    }

    message.content = createRedactedToolContent(message.content);
  }
}

/**
 * Identifies tool-calling cycles in the message history.
 *
 * @param messages - The message array to analyze
 * @returns Array of tool call cycles in chronological order
 */
function identifyToolCallCycles(messages: Message[]): ToolCallCycle[] {
  const cycles: ToolCallCycle[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    // Look for assistant messages with tool calls
    if (message.role === Role.ASSISTANT && message.toolCalls && message.toolCalls.length > 0) {
      const toolCallIds = new Set(message.toolCalls.map(tc => tc.id));
      const toolResultIndices: number[] = [];

      // Find all associated tool result messages
      for (let j = i + 1; j < messages.length; j++) {
        const candidateMessage = messages[j];

        if (candidateMessage.role === Role.TOOL && candidateMessage.toolCallId) {
          if (toolCallIds.has(candidateMessage.toolCallId)) {
            toolResultIndices.push(j);
          }
        }

        // Stop searching when we hit the next assistant message
        // (tool results should come immediately after their assistant message)
        if (candidateMessage.role === Role.ASSISTANT) {
          break;
        }
      }

      cycles.push({
        assistantMessageIndex: i,
        toolResultIndices
      });
    }
  }

  return cycles;
}

/**
 * Prunes old reasoning from assistant messages in the conversation history.
 *
 * This function marks reasoning in older assistant messages as redacted. The compats
 * handle the actual redaction behavior:
 * - OpenAI: Omits reasoning field entirely when redacted
 * - Anthropic: Injects placeholder thinking block when redacted
 *
 * @param messages - The message array to prune (modified in-place)
 * @param preserveCount - How many reasoning blocks to preserve ('all', 'none', or a number)
 *
 * @example
 * // Preserve all reasoning (default - no pruning)
 * pruneReasoning(messages, 'all');
 *
 * @example
 * // Preserve last 3 assistant messages with reasoning
 * pruneReasoning(messages, 3);
 *
 * @example
 * // Don't preserve any reasoning
 * pruneReasoning(messages, 'none');
 */
export function pruneReasoning(
  messages: Message[],
  preserveCount: ReasoningPreservation = 'all'
): void {
  // Early return if no pruning needed
  if (preserveCount === 'all') {
    return;
  }

  // Find all assistant messages with reasoning
  const messagesWithReasoning: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === Role.ASSISTANT && message.reasoning && !message.reasoning.redacted) {
      messagesWithReasoning.push(i);
    }
  }

  if (messagesWithReasoning.length === 0) {
    return; // No reasoning to prune
  }

  // Determine which reasoning to mark as redacted
  const indicesToRedact: number[] = [];

  if (preserveCount === 'none') {
    // Mark all reasoning as redacted
    indicesToRedact.push(...messagesWithReasoning);
  } else {
    // Preserve last N, mark older ones as redacted
    const toRedact = messagesWithReasoning.length - preserveCount;
    if (toRedact > 0) {
      indicesToRedact.push(...messagesWithReasoning.slice(0, toRedact));
    }
  }

  // Mark reasoning as redacted
  for (const index of indicesToRedact) {
    const message = messages[index];
    if (message.reasoning) {
      message.reasoning.redacted = true;
    }
  }
}

const TEXT_TOKEN_DIVISOR = 4;
const IMAGE_TOKEN_ESTIMATE = 768;
const TOOL_RESULT_TOKEN_DIVISOR = 6;

function estimateContentTokens(content: ContentPart[]): number {
  let total = 0;

  for (const part of content) {
    if (part.type === 'text') {
      total += Math.max(1, Math.ceil((part.text ?? '').length / TEXT_TOKEN_DIVISOR));
    } else if (part.type === 'image') {
      total += IMAGE_TOKEN_ESTIMATE;
    } else if (part.type === 'tool_result') {
      const serialized = JSON.stringify(part.result ?? '');
      total += Math.max(1, Math.ceil(serialized.length / TOOL_RESULT_TOKEN_DIVISOR));
    }
  }

  return total;
}

export function estimateMessageTokens(message: Message): number {
  let total = estimateContentTokens(message.content ?? []);

  if (message.reasoning?.text) {
    total += Math.max(1, Math.ceil(message.reasoning.text.length / TEXT_TOKEN_DIVISOR));
  }

  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      total += 8; // base overhead per tool call
      if (call.arguments) {
        total += Math.max(1, Math.ceil(JSON.stringify(call.arguments).length / TOOL_RESULT_TOKEN_DIVISOR));
      }
    }
  }

  return total;
}

export function calculateConversationTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

interface TrimOptions {
  preserveSystem?: boolean;
  preserveRoles?: Role[];
}

function resolvePriority(message: Message): number {
  const metaPriority = (message as any).metadata?.priority;
  if (typeof metaPriority === 'number' && Number.isFinite(metaPriority)) {
    return metaPriority;
  }
  if (message.role === Role.SYSTEM) return -10;
  if (message.role === Role.USER) return 0;
  if (message.role === Role.ASSISTANT) return 1;
  if (message.role === Role.TOOL) return 2;
  return 5;
}

export function trimConversationToBudget(
  messages: Message[],
  maxTokens: number,
  options: TrimOptions = {}
): Message[] {
  const working = [...messages];
  const preserveRoles = new Set(options.preserveRoles ?? []);
  const preserveSystem = options.preserveSystem ?? true;

  while (calculateConversationTokens(working) > maxTokens && working.length > 0) {
    let removalIndex = -1;
    let highestPriorityScore = -Infinity;

    for (let i = 0; i < working.length; i++) {
      const message = working[i];
      if (preserveSystem && message.role === Role.SYSTEM) continue;
      if (preserveRoles.has(message.role)) continue;
      const priorityScore = resolvePriority(message);
      if (removalIndex === -1 || priorityScore > highestPriorityScore) {
        removalIndex = i;
        highestPriorityScore = priorityScore;
      }
    }

    if (removalIndex === -1) {
      break;
    }

    working.splice(removalIndex, 1);
  }

  return working;
}
