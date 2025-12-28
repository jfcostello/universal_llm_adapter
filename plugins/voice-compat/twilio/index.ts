import type http from 'http';

import { createRealtimeSession } from '../../../modules/realtime/index.js';
import { createTwilioMediaStreamsBridge } from '../../voice-modules/twilio-media-streams/index.js';

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildTwiMLConnectStream(options: { wsUrl: string; parameters: Record<string, string> }): string {
  const wsUrl = escapeXmlAttr(String(options.wsUrl));

  const params = Object.entries(options.parameters)
    .filter(([_, v]) => typeof v === 'string' && v.length > 0)
    .map(([k, v]) => `      <Parameter name=\"${escapeXmlAttr(String(k))}\" value=\"${escapeXmlAttr(String(v))}\" />`)
    .join('\n');

  return `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Connect>\n    <Stream url=\"${wsUrl}\">\n${params}\n    </Stream>\n  </Connect>\n</Response>\n`;
}

function requireVoiceWsTokenSecret(): string {
  const secret = String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET ?? '').trim();
  if (!secret) {
    throw new Error('Missing LLM_ADAPTER_VOICE_WS_TOKEN_SECRET');
  }
  return secret;
}

export default class TwilioVoiceCompat {
  async createWebhookResponse(options: {
    req: http.IncomingMessage;
    callConfigId: string;
    callConfig: any;
    voiceProvider: string;
    mediaWsUrl: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const callConfigId = String(options.callConfigId);
    const callConfig = options.callConfig ?? {};
    const to = typeof callConfig.to === 'string' ? callConfig.to : '';
    const from = typeof callConfig.from === 'string' ? callConfig.from : '';
    const direction = String(callConfig.direction ?? '');

    const xml = buildTwiMLConnectStream({
      wsUrl: String(options.mediaWsUrl),
      parameters: {
        callConfigId,
        to,
        from,
        direction
      }
    });

    return {
      status: 200,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: xml
    };
  }

  async handleMediaConnection(options: {
    ws: any;
    req: http.IncomingMessage;
    callConfigId: string;
    callConfig: any;
    voiceProvider: string;
    registry: any;
  }): Promise<void> {
    const callConfig = options.callConfig ?? {};
    const systemPrompt = callConfig.systemPrompt;
    const realtimeSpec = callConfig.realtimeSpec ?? {};

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async ({ metadata }) => {
        const existingMetadataRaw = (realtimeSpec as any)?.metadata;
        const existingMetadata =
          existingMetadataRaw && typeof existingMetadataRaw === 'object' && !Array.isArray(existingMetadataRaw)
            ? existingMetadataRaw
            : {};

        const mergedSpec = {
          ...(realtimeSpec as any),
          ...(systemPrompt !== undefined ? { systemPrompt: String(systemPrompt) } : {}),
          metadata: {
            ...existingMetadata,
            callConfigId: String(options.callConfigId),
            voiceProvider: String(options.voiceProvider),
            providerCallMetadata: metadata
          }
        };
        return await createRealtimeSession(options.registry, mergedSpec);
      },
      security: {
        tokenSecret: requireVoiceWsTokenSecret(),
        tokenMaxTtlSeconds: 86400
      }
    });

    await bridge.handleConnection(options.ws, options.req);
  }

  async createOutboundCall(): Promise<{ providerCallId: string }> {
    const error = new Error('Outbound call initiation not implemented');
    (error as any).statusCode = 501;
    (error as any).code = 'not_implemented';
    throw error;
  }
}
