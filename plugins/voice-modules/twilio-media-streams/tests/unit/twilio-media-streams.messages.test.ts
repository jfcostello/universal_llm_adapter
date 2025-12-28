import {
  buildTwilioClearMessage,
  buildTwilioMarkMessage,
  buildTwilioMediaMessage,
  parseTwilioInboundMessage
} from '@/plugins/voice-modules/twilio-media-streams/internal/messages.ts';

describe('plugins/voice-modules/twilio-media-streams — message parsing/building', () => {
  test('parses connected', () => {
    const msg = parseTwilioInboundMessage(JSON.stringify({ event: 'connected' }));
    expect(msg.event).toBe('connected');
  });

  test('parses start with top-level streamSid', () => {
    const msg = parseTwilioInboundMessage(JSON.stringify({ event: 'start', streamSid: 'MZ1', start: { streamSid: 'MZ1' } }));
    expect(msg).toEqual(expect.objectContaining({ event: 'start', streamSid: 'MZ1' }));
  });

  test('parses start with nested start.streamSid when top-level missing', () => {
    const msg = parseTwilioInboundMessage(JSON.stringify({ event: 'start', start: { streamSid: 'MZ2' } }));
    expect(msg).toEqual(expect.objectContaining({ event: 'start', streamSid: 'MZ2' }));
  });

  test('parses media', () => {
    const msg = parseTwilioInboundMessage(JSON.stringify({ event: 'media', streamSid: 'MZ1', media: { payload: 'AAA=' } }));
    expect(msg).toEqual(expect.objectContaining({ event: 'media', streamSid: 'MZ1', payloadBase64: 'AAA=' }));
  });

  test('parses mark', () => {
    const msg = parseTwilioInboundMessage(JSON.stringify({ event: 'mark', streamSid: 'MZ1', mark: { name: 'm1' } }));
    expect(msg).toEqual(expect.objectContaining({ event: 'mark', name: 'm1' }));
  });

  test('parses dtmf', () => {
    const msg = parseTwilioInboundMessage(JSON.stringify({ event: 'dtmf', streamSid: 'MZ1', dtmf: { digit: '5' } }));
    expect(msg).toEqual(expect.objectContaining({ event: 'dtmf', digit: '5' }));
  });

  test('parses stop', () => {
    const msg = parseTwilioInboundMessage(JSON.stringify({ event: 'stop', streamSid: 'MZ1' }));
    expect(msg).toEqual(expect.objectContaining({ event: 'stop', streamSid: 'MZ1' }));
  });

  test('rejects invalid json', () => {
    expect(() => parseTwilioInboundMessage('{')).toThrow('Invalid JSON');
  });

  test('rejects non-object json', () => {
    expect(() => parseTwilioInboundMessage('1')).toThrow('Invalid message');
  });

  test('rejects missing event', () => {
    expect(() => parseTwilioInboundMessage(JSON.stringify({ streamSid: 'MZ1' }))).toThrow('Invalid event');
  });

  test('rejects unsupported event', () => {
    expect(() => parseTwilioInboundMessage(JSON.stringify({ event: 'nope', streamSid: 'MZ1' }))).toThrow('Unsupported event');
  });

  test('rejects missing streamSid', () => {
    expect(() => parseTwilioInboundMessage(JSON.stringify({ event: 'media', media: { payload: 'AAA=' } }))).toThrow('Missing streamSid');
  });

  test('rejects invalid payload shapes', () => {
    expect(() => parseTwilioInboundMessage(JSON.stringify({ event: 'start', streamSid: 'MZ1', start: null }))).toThrow('Invalid start payload');
    expect(() => parseTwilioInboundMessage(JSON.stringify({ event: 'media', streamSid: 'MZ1', media: null }))).toThrow('Invalid media payload');
    expect(() => parseTwilioInboundMessage(JSON.stringify({ event: 'mark', streamSid: 'MZ1', mark: null }))).toThrow('Invalid mark payload');
    expect(() => parseTwilioInboundMessage(JSON.stringify({ event: 'dtmf', streamSid: 'MZ1', dtmf: null }))).toThrow('Invalid dtmf payload');
  });

  test('builds outbound messages', () => {
    expect(buildTwilioMediaMessage({ streamSid: 'MZ1', payloadBase64: 'AAA=' })).toEqual({
      event: 'media',
      streamSid: 'MZ1',
      media: { payload: 'AAA=' }
    });
    expect(buildTwilioMarkMessage({ streamSid: 'MZ1', name: 'm1' })).toEqual({
      event: 'mark',
      streamSid: 'MZ1',
      mark: { name: 'm1' }
    });
    expect(buildTwilioClearMessage({ streamSid: 'MZ1' })).toEqual({ event: 'clear', streamSid: 'MZ1' });
  });
});
