import type http from 'http';

export default class TestVoiceCompat {
  async validateWebhookRequest(options: { req: http.IncomingMessage }) {
    const signature = String(options.req?.headers?.['x-test-signature'] ?? '').trim();
    if (!signature) {
      const error = new Error('Unauthorized: missing signature');
      (error as any).statusCode = 401;
      (error as any).code = 'unauthorized';
      throw error;
    }
    if (signature !== 'ok') {
      const error = new Error('Unauthorized: invalid signature');
      (error as any).statusCode = 401;
      (error as any).code = 'unauthorized';
      throw error;
    }
  }

  async createWebhookResponse(options: { mediaWsUrl: string; callConfigId: string }) {
    const url = String(options.mediaWsUrl);
    const callConfigId = String(options.callConfigId);
    const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Connect>\n    <Stream url=\"${url}\">\n      <Parameter name=\"callConfigId\" value=\"${callConfigId}\" />\n    </Stream>\n  </Connect>\n</Response>\n`;

    return {
      status: 200,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: xml
    };
  }

  async handleMediaConnection(options: { ws: any; req: http.IncomingMessage; callConfigId: string }) {
    const callConfigId = String(options.callConfigId);
    try {
      options.ws.send(JSON.stringify({ type: 'ready', callConfigId }));
    } catch {}
    try { options.ws.close(); } catch {}
  }

  async createOutboundCall(_options: any) {
    return { providerCallId: 'test_provider_call_id' };
  }
}
