import type { VoiceMediaInboundEvent, VoiceMediaProtocolAdapter } from '../../../../../../modules/media-bridge/index.js';

import {
  buildTwilioClearMessage,
  buildTwilioMarkMessage,
  buildTwilioMediaMessage,
  parseTwilioInboundMessage
} from './messages.js';

export interface TwilioCallMetadata {
  streamSid: string;
  callSid: string;
  accountSid: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  customParameters: Record<string, string>;
}

function sanitizeCustomParameters(value: any): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (String(k).toLowerCase() === 'voicemediatoken') continue;
    if (typeof v === 'string') out[String(k)] = v;
    else if (v === null || v === undefined) continue;
    else out[String(k)] = String(v);
  }
  return out;
}

function pickFirstString(custom: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const v = custom[key];
    if (typeof v === 'string' && v) return v;
    const alt = custom[key.toLowerCase()];
    if (typeof alt === 'string' && alt) return alt;
    const alt2 = custom[key.toUpperCase()];
    if (typeof alt2 === 'string' && alt2) return alt2;
  }
  return '';
}

function getDirection(custom: Record<string, string>): 'inbound' | 'outbound' {
  const raw = pickFirstString(custom, ['direction', 'callDirection']).toLowerCase();
  return raw === 'outbound' ? 'outbound' : 'inbound';
}

function extractMetadata(options: {
  streamSid: string;
  start: any;
}): TwilioCallMetadata {
  const start = options.start;
  const customParameters = sanitizeCustomParameters(start.customParameters);
  const from = pickFirstString(customParameters, ['from', 'From']);
  const to = pickFirstString(customParameters, ['to', 'To']);
  return {
    streamSid: options.streamSid,
    callSid: String(start.callSid ?? ''),
    accountSid: String(start.accountSid ?? ''),
    from,
    to,
    direction: getDirection(customParameters),
    customParameters
  };
}

export function createTwilioMediaStreamsProtocolAdapter(): VoiceMediaProtocolAdapter<TwilioCallMetadata> {
  return {
    parseInbound: (raw: string): VoiceMediaInboundEvent<TwilioCallMetadata> => {
      const msg = parseTwilioInboundMessage(raw);
      switch (msg.event) {
        case 'connected':
          return { type: 'connected' };
        case 'start':
          return { type: 'start', streamId: msg.streamSid, metadata: extractMetadata({ streamSid: msg.streamSid, start: msg.start }) };
        case 'media':
          return { type: 'media', streamId: msg.streamSid, payloadBase64: msg.payloadBase64 };
        case 'mark':
          return { type: 'mark', streamId: msg.streamSid, name: msg.name };
        case 'dtmf':
          return { type: 'dtmf', streamId: msg.streamSid, digit: msg.digit };
        case 'stop':
          return { type: 'stop', streamId: msg.streamSid };
      }
    },
    buildClearMessage: ({ streamId }) => buildTwilioClearMessage({ streamSid: streamId }),
    buildMarkMessage: ({ streamId, name }) => buildTwilioMarkMessage({ streamSid: streamId, name }),
    buildAudioMessage: ({ streamId, payloadBase64 }) => buildTwilioMediaMessage({ streamSid: streamId, payloadBase64 })
  };
}
