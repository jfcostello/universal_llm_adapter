import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '../../../../..');
const exampleDir = __dirname;

const STATIC_PORT = Number(process.env.REALTIME_WEBRTC_EXAMPLE_PORT ?? 8000);
const ADAPTER_PORT = Number(process.env.REALTIME_WEBRTC_ADAPTER_PORT ?? 8787);
const HOST = process.env.REALTIME_WEBRTC_HOST ?? '127.0.0.1';

const adapterAuthKey =
  process.env.REALTIME_WEBRTC_ADAPTER_KEY ??
  crypto.randomBytes(16).toString('hex');

const adapterOrigin = `http://${HOST}:${ADAPTER_PORT}`;
const staticOrigin = `http://${HOST}:${STATIC_PORT}`;

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function createStaticServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', staticOrigin);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const pathname = decodeURIComponent(url.pathname);
    const rel = pathname === '/' ? '/index.html' : pathname;
    const safeRel = rel.replace(/\\.{2,}/g, '.');
    const filePath = path.join(exampleDir, safeRel);

    if (!filePath.startsWith(exampleDir)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    res.writeHead(200, { 'content-type': contentTypeFor(filePath) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

async function loadAdapterServer() {
  const serverEntry = path.join(repoRoot, 'dist/modules/server/index.js');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(
      `Missing build output: ${serverEntry}. Run \\\"npm run build\\\" from repo root first.`
    );
  }
  const serverUrl = pathToFileURL(serverEntry).href;
  const mod = await import(serverUrl);
  if (!mod?.createServer) {
    throw new Error('dist/modules/server/index.js does not export createServer');
  }
  return mod.createServer;
}

const createServer = await loadAdapterServer();

const adapterServer = await createServer({
  host: HOST,
  port: ADAPTER_PORT,
  pluginsPath: path.join(repoRoot, 'plugins'),
  auth: {
    enabled: true,
    allowBearer: true,
    allowApiKeyHeader: true,
    apiKeys: [adapterAuthKey]
  },
  cors: {
    enabled: true,
    allowedOrigins: [staticOrigin],
    allowedHeaders: ['content-type', 'authorization', 'x-api-key']
  }
});

const staticServer = createStaticServer();
await new Promise((resolve) => staticServer.listen(STATIC_PORT, HOST, resolve));

console.log('');
console.log('Realtime WebRTC browser example is running.');
console.log('');
console.log(`Static site:  ${staticOrigin}`);
console.log(`Adapter API:  ${adapterOrigin}`);
console.log('');
console.log('Adapter auth token (paste into the browser UI):');
console.log(adapterAuthKey);
console.log('');
console.log('Notes:');
console.log('- Ensure OPENAI_API_KEY is set in your environment before starting this helper.');
console.log('- This helper enables adapter auth and CORS for the example origin only.');
console.log('');

async function shutdown() {
  try {
    staticServer.close();
  } catch {}
  try {
    await adapterServer.close();
  } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

