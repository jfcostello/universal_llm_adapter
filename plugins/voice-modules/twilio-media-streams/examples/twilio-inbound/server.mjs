import crypto from 'crypto';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';

import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../../../../');

const { PluginRegistry } = await import(path.join(rootDir, 'dist', 'modules', 'kernel', 'index.js'));
const { createRealtimeSession } = await import(path.join(rootDir, 'dist', 'modules', 'realtime', 'index.js'));
const { createTwilioMediaStreamsBridge } = await import(
  path.join(rootDir, 'dist', 'plugins', 'voice-modules', 'twilio-media-streams', 'index.js')
);

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL;

const tokenSecret = process.env.TWILIO_STREAM_TOKEN_SECRET || '';
if (!tokenSecret) {
  throw new Error('Missing TWILIO_STREAM_TOKEN_SECRET');
}

function base64UrlEncode(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createSignedWsToken(secret, payload) {
  const json = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(Buffer.from(json, 'utf-8'));
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = base64UrlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

function makeStreamUrl() {
  if (!publicBaseUrl) {
    throw new Error('Missing PUBLIC_BASE_URL (must be your public https base URL)');
  }
  const wsUrl = new URL('/twilio/media', publicBaseUrl);
  wsUrl.protocol = wsUrl.protocol.replace('http', 'ws');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = createSignedWsToken(tokenSecret, {
    iat: nowSeconds,
    exp: nowSeconds + 60,
    nonce: crypto.randomUUID()
  });
  wsUrl.searchParams.set('token', token);
  return wsUrl.toString();
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const pluginsPath = path.join(rootDir, 'plugins');
const registry = new PluginRegistry(pluginsPath);

const bridge = createTwilioMediaStreamsBridge({
  createSession: async ({ metadata }) => {
    const provider = process.env.REALTIME_PROVIDER_ID;
    if (!provider) throw new Error('Missing REALTIME_PROVIDER_ID');

    return await createRealtimeSession(registry, {
      provider,
      model: process.env.REALTIME_MODEL || undefined,
      systemPrompt: process.env.REALTIME_SYSTEM_PROMPT || undefined,
      transcription: { enabled: true },
      turnDetection: { mode: 'server_vad' },
      bargeIn: { enabled: true, triggers: ['user_speech.started'] },
      audio: {
        input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
        output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
      },
      metadata
    });
  },
  security: {
    tokenSecret
  },
  callbacks: {
    onCallStart: (md) => {
      console.log('[call.start]', {
        streamSid: md.streamSid,
        callSid: md.callSid,
        accountSid: md.accountSid,
        from: md.from,
        to: md.to,
        direction: md.direction
      });
    },
    onDtmf: ({ digit, metadata }) => {
      console.log('[call.dtmf]', { streamSid: metadata.streamSid, digit });
    },
    onMark: ({ name, playedMs, metadata }) => {
      console.log('[call.mark]', { streamSid: metadata.streamSid, name, playedMs });
    },
    onRealtimeEvent: ({ event, metadata }) => {
      if (event.type === 'assistant_audio.chunk') return; // avoid audio payload logging
      console.log('[realtime]', metadata.streamSid, event.type);
    },
    onError: ({ message, code }) => {
      console.warn('[bridge.error]', code, message);
    }
  }
});

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end('Missing url');
    return;
  }

  const url = new URL(req.url, `http://${host}:${port}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname === '/twiml') {
    const streamUrl = makeStreamUrl();
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const direction = url.searchParams.get('direction') || 'inbound';

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <Stream url="${escapeXml(streamUrl)}">\n      <Parameter name="from" value="${escapeXml(from)}" />\n      <Parameter name="to" value="${escapeXml(to)}" />\n      <Parameter name="direction" value="${escapeXml(direction)}" />\n    </Stream>\n  </Connect>\n</Response>\n`;

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/twilio/media' });
wss.on('connection', (ws, req) => {
  void bridge.handleConnection(ws, req);
});

server.listen(port, host, () => {
  const addr = server.address();
  console.log(`[server] listening on http://${host}:${addr.port}`);
  console.log('[server] health:', `http://${host}:${addr.port}/health`);
  console.log('[server] twiml:', `http://${host}:${addr.port}/twiml`);
});
