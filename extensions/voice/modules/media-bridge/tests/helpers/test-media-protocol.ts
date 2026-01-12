import { bytesToBase64 } from '@/modules/audio/index.ts';
import { createVoiceMediaWsBridge, type VoiceMediaProtocolAdapter } from '@/extensions/voice/modules/media-bridge/index.ts';

export type TestCallMetadata = {
  streamSid: string;
  callSid: string;
  accountSid: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  customParameters: Record<string, string>;
};

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

function extractMetadata(options: { streamSid: string; start: any }): TestCallMetadata {
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

export const TEST_MEDIA_PROTOCOL_ADAPTER: VoiceMediaProtocolAdapter<TestCallMetadata> = {
  parseInbound: (raw: string) => {
    const parsed = JSON.parse(raw);
    const event = String(parsed?.event ?? '');
    if (event === 'connected') return { type: 'connected' };

    const streamSid = String(parsed?.streamSid ?? parsed?.start?.streamSid ?? '').trim();
    if (!streamSid) throw new Error('Missing streamSid');

    if (event === 'start') {
      if (!parsed?.start || typeof parsed.start !== 'object') throw new Error('Invalid start payload');
      return { type: 'start', streamId: streamSid, metadata: extractMetadata({ streamSid, start: parsed.start }) };
    }
    if (event === 'media') {
      const payloadBase64 = String(parsed?.media?.payload ?? '').trim();
      if (!payloadBase64) throw new Error('Invalid media.payload');
      return { type: 'media', streamId: streamSid, payloadBase64 };
    }
    if (event === 'mark') {
      const name = String(parsed?.mark?.name ?? '').trim();
      if (!name) throw new Error('Invalid mark.name');
      return { type: 'mark', streamId: streamSid, name };
    }
    if (event === 'dtmf') {
      const digit = String(parsed?.dtmf?.digit ?? '').trim();
      if (!digit) throw new Error('Invalid dtmf.digit');
      return { type: 'dtmf', streamId: streamSid, digit };
    }
    if (event === 'stop') {
      return { type: 'stop', streamId: streamSid };
    }

    throw new Error(`Unsupported event: ${event}`);
  },
  buildClearMessage: ({ streamId }) => ({ event: 'clear', streamSid: streamId }),
  buildMarkMessage: ({ streamId, name }) => ({ event: 'mark', streamSid: streamId, mark: { name } }),
  buildAudioMessage: ({ streamId, payloadBase64 }) => ({ event: 'media', streamSid: streamId, media: { payload: payloadBase64 } })
};

export function createTestMediaBridge(options: any) {
  return createVoiceMediaWsBridge({
    createSession: options.createSession,
    adapter: TEST_MEDIA_PROTOCOL_ADAPTER,
    mediaAudio: {
      input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
      output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
    },
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.audio ? { audio: options.audio } : {}),
    ...(options.callbacks ? { callbacks: options.callbacks } : {})
  } as any);
}

export function startMessage(options: { streamSid?: string; accountSid?: string; customParameters?: any } = {}) {
  const streamSid = options.streamSid ?? 'MZ123';
  return JSON.stringify({
    event: 'start',
    streamSid,
    start: {
      streamSid,
      callSid: 'CA123',
      accountSid: options.accountSid ?? 'AC123',
      customParameters: options.customParameters
    }
  });
}

export function mediaMessage(options: { streamSid?: string; payloadBase64?: string } = {}) {
  return JSON.stringify({
    event: 'media',
    streamSid: options.streamSid ?? 'MZ123',
    media: { payload: options.payloadBase64 ?? bytesToBase64(new Uint8Array(160).fill(0xff)) }
  });
}

export function markMessage(options: { streamSid?: string; name?: string } = {}) {
  return JSON.stringify({
    event: 'mark',
    streamSid: options.streamSid ?? 'MZ123',
    mark: { name: options.name ?? 'm1' }
  });
}

export function dtmfMessage(options: { streamSid?: string; digit?: string } = {}) {
  return JSON.stringify({
    event: 'dtmf',
    streamSid: options.streamSid ?? 'MZ123',
    dtmf: { digit: options.digit ?? '5' }
  });
}

export function connectedMessage() {
  return JSON.stringify({ event: 'connected' });
}

export function stopMessage(options: { streamSid?: string } = {}) {
  return JSON.stringify({ event: 'stop', streamSid: options.streamSid ?? 'MZ123' });
}
