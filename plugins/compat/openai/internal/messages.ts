import type { ContentPart, Message } from '../../../../kernel/index.js';
import { Role } from '../../../../kernel/index.js';

export function hasPDFDocuments(messages: Message[]): boolean {
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'document' && part.mimeType === 'application/pdf') {
        return true;
      }
    }
  }
  return false;
}

export function serializeMessages(messages: Message[]): any[] {
  const serialized = messages.map((message, index) => {
    const ser: any = {
      role: message.role
    };

    if (message.toolCallId) {
      ser.tool_call_id = message.toolCallId;
    }

    if (message.name) {
      // Sanitize name to match OpenAI pattern: ^[a-zA-Z0-9_-]+$
      const sanitizedName = message.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      if (process.env.LLM_LIVE === '1') {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'debug',
            message: 'Sanitizing message name',
            data: {
              index,
              originalName: message.name,
              sanitizedName
            }
          })
        );
      }
      ser.name = sanitizedName;
    }

    // Add reasoning if present and not redacted (MUST be processed before toolCalls)
    if (message.reasoning && !message.reasoning.redacted) {
      if (message.reasoning.metadata?.rawDetails) {
        ser.reasoning_details = message.reasoning.metadata.rawDetails;
      } else {
        ser.reasoning = message.reasoning.text;
      }
    }

    // Process toolCalls AFTER reasoning so we can properly merge encrypted signatures
    if (message.toolCalls) {
      ser.tool_calls = message.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments)
        }
      }));

      const encryptedSignatures = message.toolCalls
        .filter(call => call.metadata?.encryptedSignature)
        .map(call => call.metadata!.encryptedSignature);

      if (encryptedSignatures.length > 0) {
        if (ser.reasoning_details) {
          const existingNonEncrypted = ser.reasoning_details.filter(
            (d: any) => d.type !== 'reasoning.encrypted'
          );
          ser.reasoning_details = [...existingNonEncrypted, ...encryptedSignatures];
        } else {
          ser.reasoning_details = encryptedSignatures;
        }
      }
    }

    const contentParts = serializeContent(message.content);
    ser.content =
      contentParts.length > 0
        ? contentParts
        : message.role === Role.ASSISTANT || message.role === Role.TOOL
          ? ''
          : [];

    return ser;
  });

  if (process.env.LLM_LIVE === '1') {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'debug',
        message: 'Serialized messages',
        data: { messages: serialized }
      })
    );
  }

  return serialized;
}

export function serializeContent(parts: ContentPart[]): any[] {
  return parts
    .map(part => {
      if (part.type === 'text') {
        return { type: 'text', text: part.text };
      }
      if (part.type === 'image') {
        return {
          type: 'image_url',
          image_url: { url: part.imageUrl }
        };
      }
      if (part.type === 'document') {
        const fileBlock: any = {
          type: 'file',
          file: {}
        };

        if (part.source.type === 'base64') {
          const dataUrl = `data:${part.mimeType};base64,${part.source.data}`;
          fileBlock.file = {
            filename: part.filename || 'document',
            file_data: dataUrl
          };
        } else if (part.source.type === 'url') {
          throw new Error(
            'OpenAI Chat Completions does not support file URLs. Use file_id or base64.'
          );
        } else if (part.source.type === 'file_id') {
          fileBlock.file = {
            file_id: part.source.fileId
          };
        }

        return fileBlock;
      }
      return null;
    })
    .filter(Boolean);
}

