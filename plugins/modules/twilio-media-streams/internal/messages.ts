export type TwilioInboundMessage =
  | { event: 'connected'; raw: any }
  | { event: 'start'; streamSid: string; start: any }
  | { event: 'media'; streamSid: string; payloadBase64: string; media: any }
  | { event: 'mark'; streamSid: string; name: string; mark: any }
  | { event: 'dtmf'; streamSid: string; digit: string; dtmf: any }
  | { event: 'stop'; streamSid: string; stop: any };

function isObject(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expectString(value: any, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function getStreamSid(message: any): string {
  // Common shapes:
  // - message.streamSid
  // - message.start.streamSid (start event)
  const top = message.streamSid;
  if (typeof top === 'string' && top) return top;

  const start = message.start;
  if (isObject(start) && typeof start.streamSid === 'string' && start.streamSid) return start.streamSid;

  throw new Error('Missing streamSid');
}

export function parseTwilioInboundMessage(raw: string): TwilioInboundMessage {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON');
  }

  if (!isObject(parsed)) throw new Error('Invalid message');
  const event = expectString(parsed.event, 'event');

  if (event === 'connected') {
    return { event: 'connected', raw: parsed };
  }

  if (event === 'start') {
    const streamSid = getStreamSid(parsed);
    if (!isObject(parsed.start)) throw new Error('Invalid start payload');
    return { event: 'start', streamSid, start: parsed.start };
  }

  if (event === 'media') {
    const streamSid = getStreamSid(parsed);
    if (!isObject(parsed.media)) throw new Error('Invalid media payload');
    const payloadBase64 = expectString(parsed.media.payload, 'media.payload');
    return { event: 'media', streamSid, payloadBase64, media: parsed.media };
  }

  if (event === 'mark') {
    const streamSid = getStreamSid(parsed);
    if (!isObject(parsed.mark)) throw new Error('Invalid mark payload');
    const name = expectString(parsed.mark.name, 'mark.name');
    return { event: 'mark', streamSid, name, mark: parsed.mark };
  }

  if (event === 'dtmf') {
    const streamSid = getStreamSid(parsed);
    if (!isObject(parsed.dtmf)) throw new Error('Invalid dtmf payload');
    const digit = expectString(parsed.dtmf.digit, 'dtmf.digit');
    return { event: 'dtmf', streamSid, digit, dtmf: parsed.dtmf };
  }

  if (event === 'stop') {
    const streamSid = getStreamSid(parsed);
    return { event: 'stop', streamSid, stop: parsed.stop };
  }

  throw new Error(`Unsupported event: ${event}`);
}

export function buildTwilioMediaMessage(options: { streamSid: string; payloadBase64: string }): any {
  return {
    event: 'media',
    streamSid: options.streamSid,
    media: {
      payload: options.payloadBase64
    }
  };
}

export function buildTwilioMarkMessage(options: { streamSid: string; name: string }): any {
  return {
    event: 'mark',
    streamSid: options.streamSid,
    mark: {
      name: options.name
    }
  };
}

export function buildTwilioClearMessage(options: { streamSid: string }): any {
  return {
    event: 'clear',
    streamSid: options.streamSid
  };
}
