import type { DocumentContent, LLMCallSpec, Message } from '../../../../../kernel/index.js';
import { prepareMessages as prepareBaseMessages } from '../../../../messages/index.js';
import { estimateFileSizeFromBase64, processDocumentContent } from '../../../../documents/index.js';

export function prepareMessagesWithDocuments(spec: LLMCallSpec): Message[] {
  const messages = prepareBaseMessages(spec);

  // Process document content: convert filepath sources to base64
  return messages.map(msg => ({
    ...msg,
    content: msg.content.map(part => {
      if (part.type === 'document') {
        const processed = processDocumentContent(part as DocumentContent);

        // Provider-agnostic fallback: inline text-like documents as plain text so
        // text-only models/providers can still answer doc-grounded questions.
        if (processed.source.type === 'base64') {
          const mimeType = String(processed.mimeType).toLowerCase();
          const isTextLike =
            mimeType.startsWith('text/') ||
            mimeType === 'application/json' ||
            mimeType === 'application/xml';

          if (isTextLike) {
            const disabled =
              String(process.env.LLM_ADAPTER_DISABLE_TEXT_DOCUMENT_INLINING || '').trim() === '1';
            const maxBytesEnv = String(process.env.LLM_ADAPTER_TEXT_DOCUMENT_INLINE_MAX_BYTES || '').trim();
            const parsedMaxBytes = maxBytesEnv ? Number.parseInt(maxBytesEnv, 10) : NaN;
            const maxBytesDefault = 262_144; // 256 KiB
            const maxBytes = Number.isFinite(parsedMaxBytes) && parsedMaxBytes >= 0
              ? parsedMaxBytes
              : maxBytesDefault;

            if (disabled || maxBytes === 0) {
              return processed;
            }

            const base64 = processed.source.data.replace(/\s+/g, '');
            const estimatedBytes = estimateFileSizeFromBase64(base64);
            if (estimatedBytes > maxBytes) {
              return processed;
            }

            const decoded = Buffer.from(base64, 'base64').toString('utf-8');
            const header = `Document (${processed.filename}; ${processed.mimeType}):\n`;
            return { type: 'text', text: `${header}${decoded}` } as any;
          }
        }

        return processed;
      }
      return part;
    })
  }));
}
