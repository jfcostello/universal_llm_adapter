import { createTwilioMediaStreamsProtocolAdapter } from '@/extensions/voice/plugins/compat/twilio/internal/media/streams/adapter.ts';

describe('plugins/compat/twilio: media stream protocol adapter', () => {
  test('maps inbound events and builds outbound messages', () => {
    const adapter = createTwilioMediaStreamsProtocolAdapter();

    expect(adapter.parseInbound(JSON.stringify({ event: 'connected' }))).toEqual({ type: 'connected' });

    const start = adapter.parseInbound(JSON.stringify({
      event: 'start',
      streamSid: 'MZ1',
      start: {
        streamSid: 'MZ1',
        callSid: 'CA1',
        accountSid: 'AC1',
        customParameters: {
          FROM: '+15550001111',
          TO: '+15550002222',
          calldirection: 'outbound',
          voiceMediaToken: 'secret',
          dropMe: null,
          num: 123
        }
      }
    }));

    expect(start).toEqual(expect.objectContaining({ type: 'start', streamId: 'MZ1' }));
    expect((start as any).metadata).toEqual(expect.objectContaining({
      streamSid: 'MZ1',
      callSid: 'CA1',
      accountSid: 'AC1',
      from: '+15550001111',
      to: '+15550002222',
      direction: 'outbound',
      customParameters: expect.objectContaining({ num: '123' })
    }));
    expect((start as any).metadata.customParameters.voiceMediaToken).toBeUndefined();
    expect((start as any).metadata.customParameters.dropMe).toBeUndefined();

    expect(adapter.parseInbound(JSON.stringify({
      event: 'media',
      streamSid: 'MZ1',
      media: { payload: 'AAA=' }
    }))).toEqual({ type: 'media', streamId: 'MZ1', payloadBase64: 'AAA=' });

    expect(adapter.parseInbound(JSON.stringify({
      event: 'mark',
      streamSid: 'MZ1',
      mark: { name: 'm1' }
    }))).toEqual({ type: 'mark', streamId: 'MZ1', name: 'm1' });

    expect(adapter.parseInbound(JSON.stringify({
      event: 'dtmf',
      streamSid: 'MZ1',
      dtmf: { digit: '5' }
    }))).toEqual({ type: 'dtmf', streamId: 'MZ1', digit: '5' });

    expect(adapter.parseInbound(JSON.stringify({ event: 'stop', streamSid: 'MZ1' }))).toEqual({ type: 'stop', streamId: 'MZ1' });

    expect(adapter.buildClearMessage({ streamId: 'MZ1' })).toEqual({ event: 'clear', streamSid: 'MZ1' });
    expect(adapter.buildMarkMessage({ streamId: 'MZ1', name: 'm2' })).toEqual({ event: 'mark', streamSid: 'MZ1', mark: { name: 'm2' } });
    expect(adapter.buildAudioMessage({ streamId: 'MZ1', payloadBase64: 'AAA=' })).toEqual({
      event: 'media',
      streamSid: 'MZ1',
      media: { payload: 'AAA=' }
    });
  });

  test('defaults missing callSid/accountSid and direction', () => {
    const adapter = createTwilioMediaStreamsProtocolAdapter();

    const start = adapter.parseInbound(JSON.stringify({
      event: 'start',
      streamSid: 'MZ2',
      start: {
        streamSid: 'MZ2',
        customParameters: {}
      }
    }));

    expect((start as any).metadata.callSid).toBe('');
    expect((start as any).metadata.accountSid).toBe('');
    expect((start as any).metadata.from).toBe('');
    expect((start as any).metadata.to).toBe('');
    expect((start as any).metadata.direction).toBe('inbound');
  });

  test('treats non-object customParameters as empty', () => {
    const adapter = createTwilioMediaStreamsProtocolAdapter();

    const start = adapter.parseInbound(JSON.stringify({
      event: 'start',
      streamSid: 'MZ3',
      start: {
        streamSid: 'MZ3',
        callSid: 'CA3',
        accountSid: 'AC3',
        customParameters: 'nope'
      }
    }));

    expect((start as any).metadata.customParameters).toEqual({});
  });
});
