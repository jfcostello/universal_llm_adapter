import type { ContentPart, Message } from '../../../kernel/index.js';

export type ObservabilityCaptureMessagesMode = 'none' | 'text' | 'full';

function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return !!part &&
    typeof part === 'object' &&
    (part as any).type === 'text' &&
    typeof (part as any).text === 'string';
}

export function filterMessagesForObservability(
  messages: Message[],
  mode: ObservabilityCaptureMessagesMode
): Message[] {
  if (mode === 'full') return messages;
  if (mode === 'none') return [];

  const out: Message[] = [];
  for (const message of messages) {
    const parts = Array.isArray(message?.content) ? message.content : [];
    const textOnly = parts
      .filter(isTextPart)
      .map(p => ({ type: 'text' as const, text: p.text }));
    if (textOnly.length === 0) continue;
    out.push({
      role: message.role,
      content: textOnly
    });
  }
  return out;
}

export function filterContentForObservability(
  content: ContentPart[],
  mode: ObservabilityCaptureMessagesMode
): ContentPart[] {
  if (mode === 'full') return content;
  if (mode === 'none') return [];

  const parts = Array.isArray(content) ? content : [];
  return parts
    .filter(isTextPart)
    .map(p => ({ type: 'text' as const, text: p.text }));
}

