import type http from 'http';

import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import type { VoiceServerContext } from '../core/context.js';
import { writeJson } from './utils-http.js';

export async function handleVoiceCallRecording(
  ctx: VoiceServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  const callPathParts = url.pathname.split('/').filter(Boolean);

  if (
    !(
      callPathParts.length === 4 &&
      callPathParts[0] === 'voice' &&
      callPathParts[1] === 'calls' &&
      callPathParts[2] &&
      callPathParts[3] === 'recording'
    )
  ) {
    return false;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
    return true;
  }

  if (!ctx.authConfig || ctx.authConfig.mode === 'none') {
    writeJson(res, 501, { type: 'error', error: { message: 'Voice recording endpoint requires server auth to be enabled', code: 'not_implemented' } });
    return true;
  }

  await ctx.assertAuthorizedAndRateLimited(req);

  const callConfigId = String(callPathParts[2]).trim();
  const callConfig = await ctx.store.getConfig(callConfigId);
  if (!callConfig) {
    writeJson(res, 404, { type: 'error', error: { message: 'Unknown callConfigId', code: 'not_found' } });
    return true;
  }

  const voiceProvider = String((callConfig as any)?.voiceProvider ?? '').trim();
  if (!voiceProvider) {
    writeJson(res, 400, { type: 'error', error: { message: 'Missing voiceProvider in call config', code: 'validation_error' } });
    return true;
  }

  const recordingCfg = (callConfig as any)?.recording;
  if (!(recordingCfg && typeof recordingCfg === 'object' && (recordingCfg as any).enabled === true)) {
    writeJson(res, 409, { type: 'error', error: { message: 'Recording is not enabled for this call', code: 'recording_not_enabled' } });
    return true;
  }

  let providerDefaults: any | undefined;
  try {
    const manifest = await ctx.providerPlugins.getManifest(voiceProvider);
    providerDefaults = (manifest as any)?.defaults;
  } catch {
    writeJson(res, 400, { type: 'error', error: { message: 'Unknown voiceProvider', code: 'validation_error' } });
    return true;
  }

  const compat = await ctx.providerPlugins.getCompat(voiceProvider);
  const getRecordingDownloadRequest = (compat as any)?.getRecordingDownloadRequest;
  if (typeof getRecordingDownloadRequest !== 'function') {
    writeJson(res, 501, { type: 'error', error: { message: 'Voice provider does not support recording download', code: 'not_implemented' } });
    return true;
  }

  const download = await getRecordingDownloadRequest({ callConfigId, callConfig, voiceProvider, providerDefaults });
  const downloadUrl = String(download?.url ?? '').trim();
  if (!downloadUrl) {
    writeJson(res, 502, { type: 'error', error: { message: 'Voice provider did not return a recording URL', code: 'provider_error' } });
    return true;
  }

  const controller = new AbortController();
  let didClientDisconnect = false;
  let didTimeout = false;

  const handleClientDisconnect = () => {
    didClientDisconnect = true;
    try { controller.abort(); } catch {}
  };
  req.on?.('aborted', handleClientDisconnect);
  req.on?.('close', handleClientDisconnect);
  res.on?.('close', handleClientDisconnect);

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    try { controller.abort(); } catch {}
  }, ctx.recordingProxyTimeoutMs);
  if (typeof (timeoutId as any)?.unref === 'function') {
    (timeoutId as any).unref();
  }

  try {
    const upstream = await fetch(downloadUrl, {
      method: 'GET',
      headers: (download?.headers && typeof download.headers === 'object') ? download.headers : undefined,
      signal: controller.signal
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      writeJson(res, 502, { type: 'error', error: { message: `Upstream recording download failed (${upstream.status})`, code: 'provider_error', ...(text ? { detail: text.slice(0, 500) } : {}) } });
      return true;
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const format = (recordingCfg as any)?.format === 'wav' ? 'wav' : 'mp3';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename=\"${callConfigId}.${format}\"`
    });

    if (!upstream.body) {
      res.end();
      return true;
    }

    const stream = Readable.fromWeb(upstream.body as any);
    try {
      await pipeline(stream, res);
    } catch {
      try { res.end(); } catch {}
    }
    return true;
  } catch (err: any) {
    if (didClientDisconnect) return true;
    if (err?.name === 'AbortError' && didTimeout) {
      if (!res.headersSent) {
        writeJson(res, 502, { type: 'error', error: { message: 'Upstream recording download timed out', code: 'provider_error' } });
      } else {
        try { res.end(); } catch {}
      }
      return true;
    }

    if (err?.name === 'AbortError') {
      if (!res.headersSent) {
        writeJson(res, 502, { type: 'error', error: { message: 'Upstream recording download aborted', code: 'provider_error' } });
      } else {
        try { res.end(); } catch {}
      }
      return true;
    }

    const message = err?.message ? String(err.message).slice(0, 200) : 'Upstream recording download failed';
    writeJson(res, 502, { type: 'error', error: { message, code: 'provider_error' } });
    return true;
  } finally {
    clearTimeout(timeoutId);
    req.off?.('aborted', handleClientDisconnect);
    req.off?.('close', handleClientDisconnect);
    res.off?.('close', handleClientDisconnect);
  }
}
