import type http from 'http';

import { makeHttpError } from '../../../../../modules/shared/index.js';

export default class TestVoiceCompat {
  async validateWebhookRequest(options: { req: http.IncomingMessage }) {
    const signature = String(options.req?.headers?.['x-test-signature'] ?? '').trim();
    if (!signature) {
      throw makeHttpError({ message: 'Unauthorized: missing signature', statusCode: 401, code: 'unauthorized' });
    }
    if (signature !== 'ok') {
      throw makeHttpError({ message: 'Unauthorized: invalid signature', statusCode: 401, code: 'unauthorized' });
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
