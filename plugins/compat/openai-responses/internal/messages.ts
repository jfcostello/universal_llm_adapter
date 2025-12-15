import type { ContentPart, Message, TextContent } from '../../../../modules/kernel/index.js';
import { Role } from '../../../../modules/kernel/index.js';
import { extractToolResultFromMessage } from '../../../../modules/messages/index.js';
import type { ResponsesAPIContentPart, ResponsesAPIInputItem } from './mappings.js';

function serializeContent(parts: ContentPart[], textType: 'input_text' | 'output_text'): ResponsesAPIContentPart[] {
  const out: ResponsesAPIContentPart[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      out.push({ type: textType, text: part.text });
      continue;
    }

    if (part.type === 'image') {
      out.push({
        type: 'input_image',
        image_url: part.imageUrl
      });
      continue;
    }

    if (part.type === 'document') {
      const filename = part.filename || 'document';

      if (part.source.type === 'base64') {
        const dataUrl = `data:${part.mimeType};base64,${part.source.data}`;
        out.push({
          type: 'input_file',
          filename,
          file_data: dataUrl
        });
        continue;
      }

      if (part.source.type === 'url') {
        out.push({
          type: 'input_file',
          filename,
          file_data: part.source.url
        });
        continue;
      }

      if (part.source.type === 'file_id') {
        out.push({
          type: 'input_file',
          file_id: part.source.fileId
        });
        continue;
      }
    }
  }

  return out;
}

export function serializeMessages(messages: Message[]): ResponsesAPIInputItem[] | string {
  if (messages.length === 0) {
    return [];
  }

  // Simple case: single user message with just text can be a string
  if (
    messages.length === 1 &&
    messages[0].role === Role.USER &&
    messages[0].content.length === 1 &&
    messages[0].content[0].type === 'text' &&
    !messages[0].toolCalls
  ) {
    return (messages[0].content[0] as TextContent).text;
  }

  const input: ResponsesAPIInputItem[] = [];
  let outputIdCounter = 1;

  for (const message of messages) {
    if (message.role === Role.SYSTEM) {
      const text = message.content
        .filter((c): c is TextContent => c.type === 'text')
        .map(c => c.text)
        .join('\n');

      if (text) {
        input.push({ role: 'system', content: text });
      }
      continue;
    }

    if (message.role === Role.USER) {
      const contentParts = serializeContent(message.content, 'input_text');
      if (contentParts.length > 0 || message.content.length === 0) {
        input.push({ role: 'user', content: contentParts });
      }
      continue;
    }

    if (message.role === Role.ASSISTANT) {
      const textContent = message.content
        .filter((c): c is TextContent => c.type === 'text')
        .map(c => ({ type: 'output_text' as const, text: c.text }));

      if (textContent.length > 0) {
        input.push({
          role: 'assistant',
          content: textContent
        });
      }

      if (message.toolCalls && message.toolCalls.length > 0) {
        for (const toolCall of message.toolCalls) {
          input.push({
            type: 'function_call',
            id: `fc_${outputIdCounter++}`,
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments)
          });
        }
      }

      continue;
    }

    if (message.role === Role.TOOL) {
      const extracted = extractToolResultFromMessage(message)!;
      const output = extracted.text;

      input.push({
        type: 'function_call_output',
        id: `fc_${outputIdCounter++}`,
        call_id: message.toolCallId || 'unknown',
        output
      });

      continue;
    }
  }

  return input;
}

