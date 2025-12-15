import {
  ContentPart,
  LLMCallSpec,
  Message,
  ReasoningData,
  Role,
  sanitizeToolName,
  TextContent,
  ToolResultContent
} from '../../kernel/index.js';

export function prepareMessages(spec: LLMCallSpec): Message[] {
  const baseMessages = [...spec.messages];

  if (!spec.systemPrompt) {
    return baseMessages;
  }

  const systemMessage: Message = {
    role: Role.SYSTEM,
    content: [{ type: 'text', text: spec.systemPrompt } as TextContent]
  };

  return [systemMessage, ...baseMessages];
}

export function aggregateSystemMessages(messages: Message[]): Message[] {
  const systemIndices: number[] = [];

  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === Role.SYSTEM) {
      systemIndices.push(index);
    }
  }

  if (systemIndices.length <= 1) {
    return messages;
  }

  const aggregatedParts: ContentPart[] = [];

  for (const [position, messageIndex] of systemIndices.entries()) {
    const message = messages[messageIndex];
    const parts = message.content ?? [];

    if (position > 0 && aggregatedParts.length > 0 && parts.length > 0) {
      aggregatedParts.push({ type: 'text', text: '\n\n' } as TextContent);
    }

    aggregatedParts.push(...parts);
  }

  const firstSystemMessage = messages[systemIndices[0]];
  const aggregatedMessage: Message = {
    role: Role.SYSTEM,
    content: aggregatedParts
  };

  if (firstSystemMessage.name) {
    aggregatedMessage.name = firstSystemMessage.name;
  }

  if (firstSystemMessage.reasoning) {
    aggregatedMessage.reasoning = firstSystemMessage.reasoning;
  }

  const output: Message[] = [];
  let insertedAggregated = false;

  for (const message of messages) {
    if (message.role === Role.SYSTEM) {
      if (!insertedAggregated) {
        output.push(aggregatedMessage);
        insertedAggregated = true;
      }
      continue;
    }
    output.push(message);
  }

  return output;
}

export interface AssistantToolCallInput {
  id: string;
  name: string;
  arguments: Record<string, any>;
  /**
   * Compat-specific metadata for this tool call.
   * Used to preserve cryptographic signatures/opaque fields that must be sent back
   * in subsequent requests.
   */
  metadata?: Record<string, any>;
}

export interface AppendAssistantToolCallsOptions {
  sanitizeName?: (name: string) => string;
  content?: ContentPart[];
  reasoning?: ReasoningData;
}

function sanitizeAssistantContent(parts: ContentPart[] | undefined): ContentPart[] {
  if (!parts || parts.length === 0) {
    return [];
  }

  const sanitized: ContentPart[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      const text = part.text ?? '';
      const trimmed = text.trim();
      if (!trimmed) {
        continue;
      }
      sanitized.push(part);
      continue;
    }

    sanitized.push(part);
  }

  return sanitized;
}

export function appendAssistantToolCalls(
  messages: Message[],
  toolCalls: AssistantToolCallInput[],
  options: AppendAssistantToolCallsOptions = {}
): void {
  if (!toolCalls.length) {
    return;
  }

  const sanitize = options.sanitizeName ?? sanitizeToolName;
  const content = sanitizeAssistantContent(options.content);

  const sanitizedToolCalls = toolCalls.map(call => {
    const sanitized: {
      id: string;
      name: string;
      arguments: Record<string, any>;
      metadata?: Record<string, any>;
    } = {
      id: call.id,
      name: sanitize(call.name),
      arguments: call.arguments
    };
    if (call.metadata) {
      sanitized.metadata = call.metadata;
    }
    return sanitized;
  });

  const lastMessage = messages[messages.length - 1];
  if (
    lastMessage &&
    lastMessage.role === Role.ASSISTANT &&
    lastMessage.toolCalls &&
    lastMessage.toolCalls.length === sanitizedToolCalls.length &&
    lastMessage.toolCalls.every((existing, index) => {
      const incoming = sanitizedToolCalls[index];
      return (
        existing.id === incoming.id &&
        existing.name === incoming.name &&
        JSON.stringify(existing.arguments) === JSON.stringify(incoming.arguments)
      );
    })
  ) {
    // Update content but avoid duplicating identical assistant tool call message
    if (content.length > 0) {
      lastMessage.content = content;
    }
    // Update reasoning if provided (preserve existing if not provided)
    if (options.reasoning) {
      lastMessage.reasoning = options.reasoning;
    }
    return;
  }

  const message: Message = {
    role: Role.ASSISTANT,
    content,
    toolCalls: sanitizedToolCalls
  };

  // Add reasoning if provided
  if (options.reasoning) {
    message.reasoning = options.reasoning;
  }

  messages.push(message);
}

export interface ToolResultPayload {
  toolName: string;
  callId: string;
  result: any;
  resultText?: string;
}

export interface AppendToolResultOptions {
  countdownText?: string;
  maxLength?: number | null;
}

export function appendToolResult(
  messages: Message[],
  payload: ToolResultPayload,
  options: AppendToolResultOptions = {}
): void {
  const { toolName, callId, result } = payload;
  const resultText =
    payload.resultText !== undefined
      ? payload.resultText
      : typeof result === 'string'
        ? result
        : JSON.stringify(result);

  let finalText = resultText;
  let truncated = false;

  if (typeof options.maxLength === 'number' && options.maxLength > 0 && resultText.length > options.maxLength) {
    finalText = `${resultText.slice(0, options.maxLength)}…`;
    truncated = true;
  }

  const message: Message = {
    role: Role.TOOL,
    content: [
      { type: 'text', text: finalText } as TextContent,
      {
        type: 'tool_result',
        toolName,
        result
      } as ToolResultContent
    ],
    toolCallId: callId
  };

  if (options.countdownText) {
    message.content.push({ type: 'text', text: options.countdownText } as TextContent);
  }

  if (truncated) {
    message.content.push({ type: 'text', text: 'Tool result truncated due to size limits.' } as TextContent);
  }

  messages.push(message);
}
