import { makeHttpError } from '../../../../../../modules/shared/index.js';
import { createRealtimeSession } from '../../../../../../modules/realtime/index.js';

import { wrapAssistantFirstTurnEvents } from './assistant-first-turn-events.js';
import { sleepUnref } from './shared.js';

export async function createTwilioMediaBridgeSession(options: {
  registry: any;
  realtimeSpec: any;
  systemPrompt: any;
  callConfigId: string;
  voiceProvider: string;
  providerCallMetadata: any;
  assistantFirstTurnEnabled: boolean;
  assistantFirstTurnCfg: any;
  silenceTimeoutMs: number | undefined;
  scheduleAssistantAudioStartFallback: (timeoutMs: number) => void;
  requestEndCallOnce: (reason: string) => Promise<void>;
  safeLog: (level: 'debug' | 'info' | 'warning' | 'error', message: string, data?: any) => void;
  baseFields: Record<string, any>;
}): Promise<any> {
  const existingMetadataRaw = (options.realtimeSpec as any)?.metadata;
  const existingMetadata =
    existingMetadataRaw && typeof existingMetadataRaw === 'object' && !Array.isArray(existingMetadataRaw)
      ? existingMetadataRaw
      : {};

  const mergedSpec = {
    ...(options.realtimeSpec as any),
    ...(options.systemPrompt !== undefined ? { systemPrompt: String(options.systemPrompt) } : {}),
    metadata: {
      ...existingMetadata,
      callConfigId: String(options.callConfigId),
      voiceProvider: String(options.voiceProvider),
      providerCallMetadata: options.providerCallMetadata
    }
  };
  const assistantFirstTurn = (() => {
    if (!options.assistantFirstTurnEnabled) return undefined;

    const prompt = String((options.assistantFirstTurnCfg as any).prompt);
    const roleRaw = String((options.assistantFirstTurnCfg as any).role ?? 'user');
    const role: 'system' | 'user' = roleRaw === 'system' ? 'system' : 'user';
    const delayMsRaw = (options.assistantFirstTurnCfg as any).delayMs;
    const delayMs = delayMsRaw === undefined || delayMsRaw === null || delayMsRaw === '' ? 0 : Number(delayMsRaw);
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw makeHttpError({ message: 'Invalid assistantFirstTurn.delayMs', statusCode: 400, code: 'validation_error' });
    }

    return { prompt, role, delayMs };
  })();

  const session = await createRealtimeSession(options.registry, mergedSpec);
  if (!assistantFirstTurn) return session;

  const { prompt, role, delayMs } = assistantFirstTurn;

  const originalEvents = session.events.bind(session);
  session.events = wrapAssistantFirstTurnEvents({
    originalEvents,
    onReady: () => {
      void (async () => {
        try {
          const delay = sleepUnref(delayMs);
          if (delay) await delay;
          await session.sendText({ text: prompt, role });
          await session.commit();
          if (options.silenceTimeoutMs) options.scheduleAssistantAudioStartFallback(options.silenceTimeoutMs);
        } catch (error: any) {
          options.safeLog('error', 'voice.assistant_first_turn.failed', {
            ...options.baseFields,
            message: error?.message ?? String(error),
            code: error?.code !== undefined ? String(error.code) : undefined
          });
          await options.requestEndCallOnce('assistant_first_turn_failed');
        }
      })();
    }
  });

  return session;
}

