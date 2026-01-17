import type { ContentPart, DocumentContent, Message } from '../../../../kernel/index.js';
import { Role } from '../../../../kernel/index.js';
import { TOOL_BUDGET_FINAL_PROMPT_PREFIX } from './mappings.js';

export function contentPartsToText(parts: ContentPart[] | undefined): string {
  if (!parts || parts.length === 0) return '';
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text ?? '')
    .join('');
}

export function extractInstructions(messages: Message[]): string | undefined {
  const system = messages.find(m => m.role === Role.SYSTEM);
  if (!system) return undefined;
  const text = contentPartsToText(system.content);
  const trimmed = text.trim();
  return trimmed ? trimmed : undefined;
}

export function serializeThreadMessages(messages: Message[]): any[] {
  const result: any[] = [];

  for (const msg of messages) {
    if (msg.role !== Role.USER && msg.role !== Role.ASSISTANT) {
      continue;
    }

    const role = msg.role === Role.USER ? 'user' : 'assistant';
    const content = serializeMessageContent(msg.content);
    result.push({ role, content: content.length > 0 ? content : '' });
  }

  return result;
}

export function serializeMessageContent(parts: ContentPart[]): any[] {
  if (!parts || parts.length === 0) return [];

  const result: any[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'image') {
      result.push({ type: 'image_url', image_url: { url: part.imageUrl } });
      continue;
    }

    if (part.type === 'document') {
      const doc = part as DocumentContent;
      const filename = doc.filename ?? 'document';
      const mimeType = doc.mimeType ?? 'unknown';
      result.push({ type: 'text', text: `\n\n[Document attached: ${filename} (${mimeType})]` });
    }
  }

  return result;
}

export function hasDocumentParts(messages: Message[]): boolean {
  for (const msg of messages) {
    const parts = msg?.content ?? [];
    for (const part of parts) {
      if (part?.type === 'document') return true;
    }
  }
  return false;
}

export function isToolBudgetFinalPromptMessage(message: Message): boolean {
  if (!message || message.role !== Role.USER) return false;
  const text = contentPartsToText(message.content).trim();
  return text.startsWith(TOOL_BUDGET_FINAL_PROMPT_PREFIX);
}

