import http from 'http';

import TestVoiceCompat from '../../index.ts';

describe('plugins/voice-compat/test', () => {
  test('createWebhookResponse returns XML + content-type', async () => {
    const compat = new TestVoiceCompat();
    const res = await compat.createWebhookResponse({ mediaWsUrl: 'ws://example.test/voice/media?token=abc', callConfigId: 'cfg_1' });
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/xml');
    expect(res.body).toContain('voice/media');
    expect(res.body).toContain('cfg_1');
  });

  test('handleMediaConnection sends ready message and closes', async () => {
    const compat = new TestVoiceCompat();

    const sent: string[] = [];
    const ws = {
      send: (data: string) => sent.push(String(data)),
      close: () => {}
    };

    await compat.handleMediaConnection({ ws, req: new http.IncomingMessage(null as any), callConfigId: 'cfg_1' });
    expect(sent.join('\n')).toContain('cfg_1');
  });

  test('createOutboundCall returns a stable providerCallId', async () => {
    const compat = new TestVoiceCompat();
    const res = await compat.createOutboundCall({});
    expect(res.providerCallId).toBe('test_provider_call_id');
  });
});

