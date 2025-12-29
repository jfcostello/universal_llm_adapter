import type { JsonValue, RealtimeAudioFrame, RealtimeSessionSpec, UnifiedTool } from '../../../../kernel/index.js';
import { parseRealtimeSessionSettings } from '../../../../kernel/index.js';

type GrokRealtimeClientEvent = Record<string, any>;

function toProviderToolName(originalName: string, used: Set<string>): string {
  const base = String(originalName).replace(/[^a-zA-Z0-9_-]/g, '_');
  const normalized = base.length > 0 ? base : 'tool';

  let candidate = normalized;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${normalized}_${i++}`;
  }
  used.add(candidate);
  return candidate;
}

function assertValidAudioFrame(config: NonNullable<RealtimeAudioFrame>): void {
  if (config.channels !== 1) {
    throw new Error('Only mono audio (channels=1) is supported');
  }

  if (config.format === 'pcm16') {
    const rate = Number(config.sampleRateHz);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('pcm16 requires a positive sampleRateHz');
    }
    return;
  }

  if (config.format === 'g711_ulaw' || config.format === 'g711_alaw') {
    if (config.sampleRateHz !== 8000) {
      throw new Error(`${config.format} requires sampleRateHz=8000`);
    }
    return;
  }

  throw new Error(`Unsupported audio format: ${String((config as any).format)}`);
}

function toGrokAudioFormat(format: RealtimeAudioFrame['format'], sampleRateHz: number): any {
  if (format === 'pcm16') return { type: 'audio/pcm', rate: sampleRateHz };
  if (format === 'g711_ulaw') return { type: 'audio/pcmu' };
  return { type: 'audio/pcma' };
}

function resolveAudioConfig(spec: RealtimeSessionSpec): { input: RealtimeAudioFrame; output: RealtimeAudioFrame } {
  const input = spec.audio?.input ?? spec.audio?.output ?? { format: 'pcm16', sampleRateHz: 24000, channels: 1 };
  const output = spec.audio?.output ?? spec.audio?.input ?? { format: 'pcm16', sampleRateHz: 24000, channels: 1 };
  assertValidAudioFrame(input as any);
  assertValidAudioFrame(output as any);
  return { input: input as any, output: output as any };
}

function resolveVoice(spec: RealtimeSessionSpec, defaultVoice: string | undefined): string | undefined {
  const raw = (spec.metadata as any)?.voice;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof defaultVoice === 'string' && defaultVoice.trim()) return defaultVoice.trim();
  return undefined;
}

function serializeTools(tools?: UnifiedTool[]): {
  toolsForSession?: any[];
  toolNameByProviderName: Map<string, string>;
  providerNameByToolName: Map<string, string>;
} {
  const toolNameByProviderName = new Map<string, string>();
  const providerNameByToolName = new Map<string, string>();
  if (!tools || tools.length === 0) {
    return { toolsForSession: undefined, toolNameByProviderName, providerNameByToolName };
  }

  const used = new Set<string>();
  const mapped = tools.map(tool => {
    const providerName = toProviderToolName(tool.name, used);
    toolNameByProviderName.set(providerName, tool.name);
    providerNameByToolName.set(tool.name, providerName);
    return { ...tool, name: providerName };
  });

  return {
    toolsForSession: mapped.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema || { type: 'object', properties: {} }
    })),
    toolNameByProviderName,
    providerNameByToolName
  };
}

function serializeToolChoice(choice: RealtimeSessionSpec['toolChoice'], providerNameByToolName: Map<string, string>): any {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'single') {
    // Prefer per-response forcing (see `response.create` tool_choice override) to avoid
    // trapping the session in an infinite function-call loop after tool results.
    return undefined;
  }
  if (choice.type === 'required') return 'required';
  return undefined;
}

export function buildSessionUpdateEvent(options: {
  spec: RealtimeSessionSpec;
  tools?: UnifiedTool[];
  defaultVoice?: string;
}): {
  event: GrokRealtimeClientEvent;
  audio: { input: RealtimeAudioFrame; output: RealtimeAudioFrame };
  toolNameByProviderName: Map<string, string>;
  settingsWarnings: { unknownKeys: string[]; invalidKeys: string[] };
} {
  const audio = resolveAudioConfig(options.spec);
  const { values: settingsValues, unknownKeys, invalidKeys } = parseRealtimeSessionSettings(options.spec.settings, {
    temperature: { type: 'number' },
    voice: { type: 'string' }
  });

  const voiceFromSettings = typeof settingsValues.voice === 'string' ? settingsValues.voice : undefined;
  const voice = voiceFromSettings ?? resolveVoice(options.spec, options.defaultVoice);
  const temperature = typeof settingsValues.temperature === 'number' ? settingsValues.temperature : undefined;

  const turnMode = options.spec.turnDetection?.mode ?? 'manual_commit';
  const turnDetection = turnMode === 'server_vad' ? { type: 'server_vad' } : null;

  const { toolsForSession: allToolsForSession, toolNameByProviderName, providerNameByToolName } = serializeTools(options.tools);

  const toolChoice = serializeToolChoice(options.spec.toolChoice, providerNameByToolName);
  let toolsForSession = allToolsForSession;

  if (options.spec.toolChoice && typeof options.spec.toolChoice === 'object') {
    const type = options.spec.toolChoice.type;
    if (type === 'single' || type === 'required') {
      if (!toolsForSession || toolsForSession.length === 0) {
        throw new Error('toolChoice provided but no tools are configured');
      }

      if (type === 'single') {
        const providerName = providerNameByToolName.get(options.spec.toolChoice.name) ?? options.spec.toolChoice.name;
        toolsForSession = toolsForSession.filter(tool => tool.name === providerName);
        if (toolsForSession.length === 0) {
          throw new Error(`toolChoice refers to unknown tool: ${options.spec.toolChoice.name}`);
        }
      }

      if (type === 'required' && Array.isArray(options.spec.toolChoice.allowed) && options.spec.toolChoice.allowed.length > 0) {
        const allowedProviderNames = new Set(
          options.spec.toolChoice.allowed.map(name => providerNameByToolName.get(name) ?? name)
        );
        toolsForSession = toolsForSession.filter(tool => allowedProviderNames.has(tool.name));
        if (toolsForSession.length === 0) {
          throw new Error('toolChoice.required provided but no allowed tools are configured');
        }
      }
    }
  }

  const resolvedToolChoice = toolChoice ?? (toolsForSession ? 'auto' : undefined);

  const event: GrokRealtimeClientEvent = {
    type: 'session.update',
    session: {
      ...(options.spec.systemPrompt ? { instructions: options.spec.systemPrompt } : {}),
      ...(voice ? { voice } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      audio: {
        input: { format: toGrokAudioFormat(audio.input.format, audio.input.sampleRateHz) },
        output: { format: toGrokAudioFormat(audio.output.format, audio.output.sampleRateHz) }
      },
      turn_detection: turnDetection,
      ...(toolsForSession ? { tools: toolsForSession } : {}),
      ...(resolvedToolChoice ? { tool_choice: resolvedToolChoice } : {})
    }
  };

  return { event, audio, toolNameByProviderName, settingsWarnings: { unknownKeys, invalidKeys } };
}

export function buildConversationItemCreateEvent(options: {
  text: string;
  role: 'system' | 'user' | 'assistant';
}): GrokRealtimeClientEvent {
  const contentType = options.role === 'assistant' ? 'text' : 'input_text';
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: options.role,
      content: [{ type: contentType, text: options.text }]
    }
  };
}

export function buildInputAudioAppendEvent(frame: RealtimeAudioFrame): GrokRealtimeClientEvent {
  return { type: 'input_audio_buffer.append', audio: frame.dataBase64 };
}

export function buildInputAudioCommitEvent(): GrokRealtimeClientEvent {
  return { type: 'input_audio_buffer.commit' };
}

export function buildResponseCreateEvent(options: { toolChoice?: any } = {}): GrokRealtimeClientEvent {
  if (options.toolChoice !== undefined) {
    return { type: 'response.create', response: { tool_choice: options.toolChoice } };
  }
  return { type: 'response.create' };
}

export function buildResponseCancelEvent(): GrokRealtimeClientEvent {
  return { type: 'response.cancel' };
}

export function buildToolResultItemCreateEvent(options: {
  toolCallId: string;
  result: JsonValue;
}): GrokRealtimeClientEvent {
  const output = typeof options.result === 'string' ? options.result : JSON.stringify(options.result);
  return {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: options.toolCallId,
      output
    }
  };
}
