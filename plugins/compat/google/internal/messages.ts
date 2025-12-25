import type { Message, TextContent } from '../../../../modules/kernel/index.js';
import { Role, sanitizeToolName } from '../../../../modules/kernel/index.js';
import type { GoogleContent, GooglePart } from './mappings.js';

export function extractToolResponse(message: Message): [string | undefined, any] {
  const contentParts = message.content || [];
  const toolPart = contentParts.find(p => p.type === 'tool_result') as any;

  if (toolPart && toolPart.toolName) {
    // CRITICAL: Must sanitize to match functionDeclaration name
    const name = sanitizeToolName(toolPart.toolName);

    // Collect ALL text parts (formatted result + countdown text + truncation notices)
    // This is critical for the model to see tool call budget information
    const textParts = contentParts
      .filter(p => p.type === 'text')
      .map(p => (p as TextContent).text ?? '');

    // Google requires functionResponse.response to be a Struct (JSON object), not a string
    // Wrap combined text in an object structure to make it a valid Struct while preserving text.
    // Also include the raw tool result (exact value) to make it easier for Gemini to quote verbatim.
    const rawResult = toolPart.result !== undefined ? toolPart.result : undefined;

    let response: any;
    if (textParts.length > 0) {
      // Combine all text parts (result + countdown + truncation)
      const combinedText = textParts.join('\n');
      // Wrap in object with "output" key - this makes it a valid Struct while preserving text
      response = {
        output: combinedText,
        ...(rawResult !== undefined ? { result: rawResult } : {})
      };
    } else if (rawResult !== undefined) {
      response = { result: rawResult };
    } else {
      response = { output: '' };
    }

    return [name, response];
  }

  const text = (message.content || [])
    .filter(p => p.type === 'text')
    .map(p => (p as TextContent).text ?? '')
    .join('');

  return [undefined, text];
}

function serializeToolResponse(message: Message): GoogleContent {
  const [name, response] = extractToolResponse(message);
  return {
    role: 'user',
    parts: [{ functionResponse: { name, response } }]
  };
}

export function serializeMessages(messages: Message[]): { contents: GoogleContent[]; systemInstruction?: any } {
  let systemText: string | undefined;
  const contents: GoogleContent[] = [];

  for (const m of messages) {
    if (m.role === Role.SYSTEM) {
      const text = (m.content || [])
        .filter(p => p.type === 'text')
        .map(p => (p as TextContent).text ?? '')
        .join('');
      if (text && text.length) {
        systemText = (systemText || '') + text;
      }
      continue;
    }

    if (m.role === Role.TOOL) {
      contents.push(serializeToolResponse(m));
      continue;
    }

    const parts: GooglePart[] = [];

    // Text, images, and documents
    for (const part of m.content || []) {
      if (part.type === 'text') {
        parts.push({ text: (part as TextContent).text ?? '' });
      } else if (part.type === 'image') {
        const imgPart = part as any;
        parts.push({
          fileData: {
            fileUri: imgPart.imageUrl,
            mimeType: imgPart.mimeType
          }
        });
      } else if (part.type === 'document') {
        const docPart = part as any;
        if (docPart.source.type === 'base64') {
          // Google inline data format
          parts.push({
            inlineData: {
              mimeType: docPart.mimeType,
              data: docPart.source.data // Raw base64, no prefix
            }
          });
        } else if (docPart.source.type === 'url' || docPart.source.type === 'file_id') {
          // Google Files API format
          parts.push({
            fileData: {
              fileUri: docPart.source.type === 'url' ? docPart.source.url : docPart.source.fileId,
              mimeType: docPart.mimeType
            }
          });
        }
      }
    }

    // Assistant tool calls -> functionCall parts
    if (m.role === Role.ASSISTANT && m.toolCalls && m.toolCalls.length) {
      for (const call of m.toolCalls) {
        const toolCallPart: any = {
          functionCall: {
            name: call.name,
            args: call.arguments ?? {}
          }
        };
        // Preserve thoughtSignature if present in metadata
        // This is required for Gemini models with reasoning enabled
        if (call.metadata?.thoughtSignature) {
          toolCallPart.thoughtSignature = call.metadata.thoughtSignature;
        }
        parts.push(toolCallPart);
      }
    }

    if (m.role === Role.USER) {
      contents.push({ role: 'user', parts });
    } else if (m.role === Role.ASSISTANT) {
      contents.push({ role: 'model', parts });
    }
  }

  const systemInstruction = systemText ? [{ text: systemText }] : undefined;

  return { contents, systemInstruction };
}
