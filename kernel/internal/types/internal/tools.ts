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
   * Optional per-tool config to expose a strict-boolean flag inside tool call arguments that can
   * override terminal behavior for that specific call.
   *
   * This flag is injected into the tool's `parametersJsonSchema` during tool discovery and is
   * stripped from invocation args before routing/executing the tool.
   */
  toolCallTerminalFlag?: {
    /** Argument key to read from tool call arguments (e.g. "terminal"). */
    field: string;
    /** If true, add the field to JSON schema `required`. */
    required?: boolean;
    /** Optional description used for the injected schema property. */
    description?: string;
  };
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
