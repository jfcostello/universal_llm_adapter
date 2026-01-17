import type { JsonObject } from './json.js';

export interface UnifiedTool {
  name: string;
  description?: string;
  parametersJsonSchema?: JsonObject;
  /**
   * When true, executing this tool call should end the tool loop immediately after
   * the tool result is produced (no follow-up LLM call).
   */
  terminal?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
  /**
   * Alias for compatibility with existing tooling that expects `args`.
   * Always mirrors the value of `arguments`.
   */
  args?: JsonObject;
  /**
   * Provider-specific metadata for this tool call.
   * Used to preserve provider-supplied signatures that must be sent back in
   * subsequent requests.
   */
  metadata?: Record<string, any>;
}

export type ToolChoiceAuto = "auto" | "none" | "required";

export interface ToolChoiceSingle {
  type: "single";
  name: string;
}

export interface ToolChoiceRequired {
  type: "required";
  allowed: string[];
}

export type ToolChoice = ToolChoiceAuto | ToolChoiceSingle | ToolChoiceRequired;
