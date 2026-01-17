import type { JsonObject, JsonValue, RealtimeSessionSpec, UnifiedTool } from '../../../../../../kernel/index.js';
import { sanitizeToolName } from '../../../../../../kernel/index.js';

export function ensureJsonObject(value: any): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  return {};
}

function parseJsonObject(text: string): JsonObject {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return parsed as JsonObject;
}

export function coerceToolArgumentsJson(value: any): JsonObject {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string') return parseJsonObject(value);
  if (typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  throw new Error('Tool arguments must be a JSON object');
}

export function serializeTools(tools: UnifiedTool[] | undefined, toolChoice: RealtimeSessionSpec['toolChoice']): {
  toolsForModel?: any[];
  unifiedToolNameByProviderName: Map<string, string>;
  toolsWithMessageParam: Set<string>;
} {
  const unifiedToolNameByProviderName = new Map<string, string>();
  const toolsWithMessageParam = new Set<string>();
  if (!tools || tools.length === 0) return { toolsForModel: undefined, unifiedToolNameByProviderName, toolsWithMessageParam };

  if (toolChoice === 'none') {
    return { toolsForModel: undefined, unifiedToolNameByProviderName, toolsWithMessageParam };
  }

  const used = new Set<string>();
  const toProviderName = (name: string) => {
    const base = sanitizeToolName(name);
    let candidate = base;
    let i = 2;
    while (used.has(candidate)) candidate = `${base}_${i++}`;
    used.add(candidate);
    return candidate;
  };

  let selected = tools;
  if (toolChoice && typeof toolChoice === 'object') {
    if (toolChoice.type === 'single') {
      selected = tools.filter(t => t.name === toolChoice.name);
    } else if (toolChoice.type === 'required' && Array.isArray(toolChoice.allowed) && toolChoice.allowed.length > 0) {
      const allowed = new Set(toolChoice.allowed);
      selected = tools.filter(t => allowed.has(t.name));
    }
  }

  if (selected.length === 0) return { toolsForModel: undefined, unifiedToolNameByProviderName, toolsWithMessageParam };

  const toolsForModel = selected.map(t => {
    const providerName = toProviderName(t.name);
    unifiedToolNameByProviderName.set(providerName, t.name);
    const schema = ensureJsonObject(t.parametersJsonSchema);
    const props = ensureJsonObject((schema as any).properties);
    const messageSchema = (props as any).message;
    if (messageSchema && typeof messageSchema === 'object' && !Array.isArray(messageSchema) && (messageSchema as any).type === 'string') {
      toolsWithMessageParam.add(t.name);
    }
    return {
      type: 'function',
      function: {
        name: providerName,
        description: String(t.description ?? ''),
        parameters: ensureJsonObject(t.parametersJsonSchema)
      }
    };
  });

  return { toolsForModel, unifiedToolNameByProviderName, toolsWithMessageParam };
}

export function normalizeTranscriptType(rawType: string, rawTranscriptType: any): 'partial' | 'final' {
  const t = typeof rawTranscriptType === 'string' ? rawTranscriptType.trim().toLowerCase() : '';
  if (t === 'final') return 'final';
  if (t === 'partial') return 'partial';
  if (rawType.includes('transcriptType=\"final\"')) return 'final';
  return 'partial';
}

export function normalizeRole(rawRole: any): 'user' | 'assistant' | '' {
  const role = typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : '';
  if (role === 'user' || role === 'assistant') return role;
  return '';
}

export function safeToolResultText(result: JsonValue): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && !Array.isArray(result) && typeof (result as any).result === 'string') {
    return String((result as any).result);
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function extractEchoToken(text: string): string | undefined {
  const m = /^\s*ECHO\s*:\s*([^\s\r\n]+)/i.exec(text);
  if (!m) return undefined;
  return m[1];
}

