import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';
// Local lightweight type mirrors to avoid importing project code.
type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string; mimeType?: string }
  | { type: 'tool_result'; toolName: string; result: any }
  | { type: 'document'; source: any; mimeType?: string; filename?: string; providerOptions?: any };

export interface Message {
  role: Role;
  content: ContentPart[];
  toolCalls?: any;
  toolCallId?: string;
  name?: string;
  metadata?: Record<string, any>;
}

// Mirrors the public coordinator spec shape, minus messages (built per turn)
export interface LLMCallSpec {
  systemPrompt?: string;
  messages: Message[];
  functionToolNames?: string[];
  tools?: any[];
  mcpServers?: string[];
  vectorStores?: string[];
  vectorPriority?: string[];
  vectorContext?: any;
  llmPriority: any[];
  toolChoice?: any;
  rateLimitRetryDelays?: number[];
  settings: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface SandboxRunConfig {
  name?: string;
  mode?: 'run' | 'stream';
  pluginsPath?: string;
  batchId?: string;
  copyLogs?: boolean;
  transcriptPath?: string;
}

export interface SandboxScenario {
  run: SandboxRunConfig;
  baseSpec: Omit<LLMCallSpec, 'messages'>;
  initialMessages: Message[];
  turns: Message[];
  env?: Record<string, string>;
}

type MessageInput =
  | string
  | {
      role?: string;
      content?: any;
      name?: string;
      toolCalls?: any;
      metadata?: Record<string, any>;
    };

interface RawScenarioFile {
  run?: Record<string, any>;
  env?: Record<string, string>;
  spec?: Record<string, any>;
  initialMessages?: MessageInput[];
  turns?: MessageInput[];
}

export function loadScenario(filePath: string): SandboxScenario {
  const resolved = path.resolve(filePath);
  const rawContent = fs.readFileSync(resolved, 'utf-8');
  const parsed = parse(rawContent) as RawScenarioFile;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Scenario file did not parse to an object');
  }

  const run: SandboxRunConfig = {
    name: parsed.run?.name,
    mode: parsed.run?.mode ?? 'run',
    pluginsPath: parsed.run?.pluginsPath ?? './plugins',
    batchId: parsed.run?.batchId,
    copyLogs: parsed.run?.copyLogs ?? true,
    transcriptPath: parsed.run?.transcriptPath
  };

  if (run.mode !== 'run' && run.mode !== 'stream') {
    throw new Error(`run.mode must be 'run' or 'stream'; received ${String(run.mode)}`);
  }

  if (!parsed.spec) {
    throw new Error('spec section is required');
  }

  if (!Array.isArray(parsed.spec.llmPriority) || parsed.spec.llmPriority.length === 0) {
    throw new Error('spec.llmPriority must be a non-empty array');
  }

  if (!parsed.spec.settings || typeof parsed.spec.settings !== 'object') {
    throw new Error('spec.settings must be provided');
  }

  const baseSpec: Omit<LLMCallSpec, 'messages'> = {
    ...parsed.spec,
    messages: undefined as never // explicitly removed; messages built per turn
  };

  const initialMessages = (parsed.initialMessages ?? []).map((msg, idx) =>
    normalizeMessage(msg, `initialMessages[${idx}]`, undefined)
  );

  const turns = (parsed.turns ?? []).map((msg, idx) =>
    normalizeMessage(msg, `turns[${idx}]`, 'user')
  );

  if (turns.length === 0) {
    throw new Error('At least one turn is required under turns[]');
  }

  return {
    run,
    baseSpec,
    initialMessages,
    turns,
    env: parsed.env
  };
}

function normalizeMessage(
  input: MessageInput,
  label: string,
  defaultRole?: Role
): Message {
  if (typeof input === 'string') {
    return {
      role: defaultRole ?? 'user',
      content: [{ type: 'text', text: input }]
    };
  }

  if (!input || typeof input !== 'object') {
    throw new Error(`${label} must be a string or object`);
  }

  const role = (input.role as Role | undefined) ?? defaultRole ?? 'user';
  if (!role) {
    throw new Error(`${label} is missing a role`);
  }

  const content = normalizeContent(input.content, label);

  return {
    role,
    content,
    name: input.name,
    toolCalls: input.toolCalls,
    toolCallId: (input as any).toolCallId,
    metadata: (input as any).metadata
  };
}

function normalizeContent(content: any, label: string): ContentPart[] {
  if (!content) {
    return [{ type: 'text', text: '' }];
  }

  // Simple string -> single text part
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (Array.isArray(content)) {
    return content.map((part, idx) => normalizeContentPart(part, `${label}.content[${idx}]`));
  }

  // Object form: treat as single content part
  return [normalizeContentPart(content, `${label}.content`)];
}

function normalizeContentPart(part: any, label: string): ContentPart {
  if (!part || typeof part !== 'object') {
    return { type: 'text', text: String(part ?? '') };
  }

  if (!part.type) {
    return { type: 'text', text: JSON.stringify(part) };
  }

  if (part.type === 'text') {
    return { type: 'text', text: part.text ?? '' };
  }

  if (part.type === 'image') {
    return { type: 'image', imageUrl: part.imageUrl ?? part.url ?? '', mimeType: part.mimeType };
  }

  if (part.type === 'tool_result') {
    return {
      type: 'tool_result',
      toolName: part.toolName ?? part.name ?? 'tool',
      result: part.result ?? part.data ?? null
    };
  }

  if (part.type === 'document') {
    return {
      type: 'document',
      source: part.source,
      mimeType: part.mimeType,
      filename: part.filename,
      providerOptions: part.providerOptions
    };
  }

  throw new Error(`${label} has unsupported content type: ${part.type}`);
}
