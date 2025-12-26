import type { ContentPart, Message, ReasoningData } from '../../../../kernel/index.js';
import { Role } from '../../../../kernel/index.js';

function serializeToolResult(contentParts: ContentPart[]): string {
  const textParts = contentParts
    .filter(c => c.type === 'text')
    .map(c => (c as any).text);

  if (textParts.length > 0) {
    return textParts.join('\n');
  }

  return JSON.stringify(contentParts);
}

function serializeContent(parts: ContentPart[]): any[] {
  return parts
    .map(part => {
      if (part.type === 'text') {
        if (!part.text || part.text.trim() === '') {
          return null;
        }
        return { type: 'text', text: part.text };
      }
      if (part.type === 'image') {
        return {
          type: 'image',
          source: {
            type: 'url',
            url: part.imageUrl
          }
        };
      }
      if (part.type === 'document') {
        const docBlock: any = {
          type: 'document',
          source: {}
        };

        if (part.source.type === 'base64') {
          docBlock.source = {
            type: 'base64',
            media_type: part.mimeType,
            data: part.source.data
          };
        } else if (part.source.type === 'url') {
          docBlock.source = {
            type: 'url',
            url: part.source.url
          };
        } else if (part.source.type === 'file_id') {
          docBlock.source = {
            type: 'file',
            file_id: part.source.fileId
          };
        }

        if (part.providerOptions?.anthropic?.cacheControl) {
          docBlock.cache_control = part.providerOptions.anthropic.cacheControl;
        }

        return docBlock;
      }
      return null;
    })
    .filter(Boolean);
}

function serializeThinkingBlock(reasoning: ReasoningData): any {
  const thinkingBlock: any = {
    type: 'thinking',
    thinking: reasoning.text
  };

  if (reasoning.metadata?.signature) {
    thinkingBlock.signature = reasoning.metadata.signature;
  }

  return thinkingBlock;
}

export function serializeMessages(messages: Message[]): any[] {
  const anthropicMessages: any[] = [];
  let pendingToolResults: any[] = [];

  for (const message of messages) {
    if (message.role === Role.TOOL) {
      const toolResultContent = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: serializeToolResult(message.content)
      };
      pendingToolResults.push(toolResultContent);
      continue;
    }

    if (pendingToolResults.length > 0 && message.role === Role.ASSISTANT) {
      anthropicMessages.push({
        role: Role.USER,
        content: pendingToolResults
      });
      pendingToolResults = [];
    }

    const content: any[] = [];

    if (message.role === Role.ASSISTANT && message.reasoning) {
      content.push(serializeThinkingBlock(message.reasoning));
    }

    if (message.role === Role.USER && pendingToolResults.length > 0) {
      content.push(...pendingToolResults);
      pendingToolResults = [];
    }

    content.push(...serializeContent(message.content));

    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments
        });
      }
    }

    anthropicMessages.push({
      role: message.role,
      content
    });
  }

  if (pendingToolResults.length > 0) {
    anthropicMessages.push({
      role: Role.USER,
      content: pendingToolResults
    });
  }

  return anthropicMessages;
}

