import type { JsonValue } from './json.js';
import type { ToolCall } from './tools.js';

export enum Role {
  SYSTEM = "system",
  USER = "user",
  ASSISTANT = "assistant",
  TOOL = "tool"
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  imageUrl: string;
  mimeType?: string;
}

export interface ToolResultContent {
  type: "tool_result";
  toolName: string;
  result: JsonValue;
}

/**
 * Represents a document/file to be processed by the LLM.
 * Users provide file paths; the system loads, encodes, and transforms them.
 */
export interface DocumentContent {
  type: 'document';

  /**
   * Source of the document data.
   * - filepath: Local file path (will be loaded and converted to base64)
   * - base64: Already encoded base64 data
   * - url: Public URL to the document
   * - file_id: Provider-specific file ID from their Files API
   */
  source:
    | { type: 'filepath'; path: string }
    | { type: 'base64'; data: string }
    | { type: 'url'; url: string }
    | { type: 'file_id'; fileId: string };

  /**
   * MIME type of the document.
   * Examples: 'application/pdf', 'text/csv', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
   * If not provided and source is filepath, will be auto-detected.
   */
  mimeType?: string;

  /**
   * Original filename (for logging, debugging, or provider requirements).
   * If not provided and source is filepath, will be extracted from path.
   */
  filename?: string;

  /**
   * Provider-specific options (optional).
   * Only used by certain provider plugins (e.g., caching controls, document processing hints).
   */
  providerOptions?: Record<string, any>;
}

export type ContentPart = TextContent | ImageContent | DocumentContent | ToolResultContent;

export interface ReasoningData {
  text: string;
  redacted?: boolean;
  metadata?: Record<string, any>; // Provider-specific metadata returned by the compat layer
}

export interface Message {
  role: Role;
  content: ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  reasoning?: ReasoningData;
}
