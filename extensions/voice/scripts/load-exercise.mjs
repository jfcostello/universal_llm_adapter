import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function parseArgs(argv) {
  const args = { calls: 50, concurrency: 25, serverUrl: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--calls') {
      args.calls = parseNumber(v, args.calls);
      i++;
      continue;
    }
    if (k === '--concurrency') {
      args.concurrency = parseNumber(v, args.concurrency);
      i++;
      continue;
    }
    if (k === '--server-url') {
      args.serverUrl = String(v ?? '');
      i++;
      continue;
    }
  }
  args.calls = Math.max(0, args.calls);
  args.concurrency = Math.max(1, args.concurrency);
  return args;
}

function extractStreamUrl(xml) {
  const match = String(xml).match(/url=\"([^\"]+)\"/);
  if (!match?.[1]) throw new Error('Missing stream url');
  return match[1];
}

async function pool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  };

  const n = Math.min(concurrency, items.length || 1);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function readTestVoiceProviderId(pluginsPath) {
  const filePath = path.join(pluginsPath, 'voice-providers', 'test.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  const id = String(parsed?.id ?? '').trim();
  if (!id) throw new Error('Missing voice provider id in test.json');
  return id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const distServerPath = path.join(repoRoot, 'dist', 'modules', 'server', 'index.js');
  if (!fs.existsSync(distServerPath)) {
    console.error('Missing dist build. Run `npm run build` first.');
    process.exitCode = 1;
    return;
  }

  // Required for /voice/webhook → /voice/media token minting.
  process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET =
    String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET ?? '').trim() || 'dev_secret';

  const pluginsPath = path.join(repoRoot, 'plugins');
  const voiceProvider = readTestVoiceProviderId(pluginsPath);

  const apiKey = String(process.env.LLM_ADAPTER_LOAD_API_KEY ?? '').trim() || 'dev_key';

  let running;
  let serverUrl = String(args.serverUrl ?? '').trim();
  if (!serverUrl) {
    const mod = await import(pathToFileURL(distServerPath).href);
    const createServer = mod.createServer;
    if (typeof createServer !== 'function') {
      throw new Error('dist server module did not export createServer');
    }
    running = await createServer({
      host: '127.0.0.1',
      port: 0,
      pluginsPath,
      auth: { enabled: true, apiKeys: [apiKey] },
      extensions: { enabled: ['voice'] }
    });
    serverUrl = String(running?.url ?? '');
    console.log(`Server started at ${serverUrl}`);
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  const callStart = Date.now();
  const callResults = await pool(
    Array.from({ length: args.calls }, (_, i) => i),
    args.concurrency,
    async () => {
      const res = await fetch(new URL('/voice/calls', serverUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          to: 'to',
          from: 'from',
          voiceProvider,
          realtimeSpec: {}
        })
      });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, body: text };
      }
      const parsed = JSON.parse(text);
      return { ok: true, callConfigId: String(parsed.callConfigId ?? '') };
    }
  );
  const callMs = Date.now() - callStart;

  const callConfigIds = callResults.filter(r => r?.ok).map(r => r.callConfigId).filter(Boolean);
  console.log(`Calls: ${callConfigIds.length}/${args.calls} ok (${callMs}ms)`);

  const webhookStart = Date.now();
  const wsUrls = await pool(callConfigIds, args.concurrency, async (callConfigId) => {
    const res = await fetch(new URL(`/voice/webhook?callConfigId=${encodeURIComponent(callConfigId)}`, serverUrl), {
      headers: { 'x-test-signature': 'ok' }
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, body: text };
    return { ok: true, wsUrl: extractStreamUrl(text) };
  });
  const webhookMs = Date.now() - webhookStart;

  const urls = wsUrls.filter(r => r?.ok).map(r => r.wsUrl).filter(Boolean);
  console.log(`Webhooks: ${urls.length}/${callConfigIds.length} ok (${webhookMs}ms)`);

  const require = createRequire(import.meta.url);
  const Ws = require('ws');
  const WebSocket = Ws.WebSocket ?? Ws;

  const wsStart = Date.now();
  const wsOutcomes = await pool(urls, args.concurrency, async (wsUrl) => {
    return await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      let opened = false;
      let readySeen = false;

      ws.on('open', () => {
        opened = true;
      });
      ws.on('message', (data) => {
        try {
          const text = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
          const msg = JSON.parse(text);
          if (msg?.type === 'ready') readySeen = true;
        } catch {}
      });
      ws.on('close', (code) => {
        resolve({ ok: true, opened, readySeen, code: Number(code) });
      });
      ws.on('error', (err) => {
        resolve({ ok: false, opened, readySeen, error: String(err?.message ?? err) });
      });
    });
  });
  const wsMs = Date.now() - wsStart;

  const wsOk = wsOutcomes.filter(r => r?.ok).length;
  const wsReady = wsOutcomes.filter(r => r?.ok && r?.readySeen).length;
  console.log(`WS: ${wsOk}/${urls.length} ok (${wsMs}ms), ready: ${wsReady}/${urls.length}`);

  if (running?.close) {
    await running.close();
  }
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exitCode = 1;
});

