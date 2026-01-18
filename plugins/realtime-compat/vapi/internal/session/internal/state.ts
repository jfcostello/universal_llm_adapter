export type VapiSessionState = {
  closed: boolean;
  readySent: boolean;
  bufferedTextTurns: Array<{ role: 'system' | 'user'; text: string }>;
  pendingAudio: Uint8Array[];
  audioNextSendAtMs: number;
  audioSendChain: Promise<void>;
  keepaliveTimer: any | undefined;
  lastRealAudioSentAtMs: number | undefined;
  lastUserTranscript: string;
  lastAssistantTranscript: string;
  assistantTextBuffer: string;
  sawAssistantModelOutputText: boolean;
  assistantSpeechActive: boolean;
  assistantTranscriptFinalized: boolean;
  assistantTextFinalized: boolean;
  lastUserTextForToolFallback: string;
  lastConversationAssistantText: string;
  toolFallbackTimer: NodeJS.Timeout | undefined;
  toolFallbackActiveSinceMs: number | undefined;
};

export function createVapiSessionState(): VapiSessionState {
  return {
    closed: false,
    readySent: false,
    bufferedTextTurns: [],
    pendingAudio: [],
    audioNextSendAtMs: 0,
    audioSendChain: Promise.resolve(),
    keepaliveTimer: undefined,
    lastRealAudioSentAtMs: undefined,
    lastUserTranscript: '',
    lastAssistantTranscript: '',
    assistantTextBuffer: '',
    sawAssistantModelOutputText: false,
    assistantSpeechActive: false,
    assistantTranscriptFinalized: false,
    assistantTextFinalized: false,
    lastUserTextForToolFallback: '',
    lastConversationAssistantText: '',
    toolFallbackTimer: undefined,
    toolFallbackActiveSinceMs: undefined
  };
}

export function clearToolFallback(state: VapiSessionState): void {
  if (!state.toolFallbackTimer) return;
  clearTimeout(state.toolFallbackTimer);
  state.toolFallbackTimer = undefined;
  state.toolFallbackActiveSinceMs = undefined;
}

