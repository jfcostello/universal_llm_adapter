import type { JsonObject } from './json.js';

export interface UnifiedTool {
  name: string;
  /**
   * Optional stable identifier for this tool.
   * Not exposed to the model (used only for adapter-side routing).
   */
  id?: string;
  description?: string;
  parametersJsonSchema?: JsonObject;
  /**
   * When true, executing this tool call should end the tool loop immediately after
   * the tool result is produced (no follow-up LLM call).
   */
  terminal?: boolean;
  /**
   * Optional explicit process route id to use when invoking this tool.
   * This is adapter-side only; providers receive only the tool schema.
   */
  processRouteId?: string;
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

export interface ToolRoutingSpec {
  /** Explicit route selection by tool name (adapter tool name). */
  routesByName?: Record<string, string>;
  /** Explicit route selection by tool id (UnifiedTool.id). */
  routesById?: Record<string, string>;
}
