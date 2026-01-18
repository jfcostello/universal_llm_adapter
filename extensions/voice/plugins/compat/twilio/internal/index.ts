import type http from 'http';
import fs from 'fs';
import path from 'path';

import { safeEqual } from '../../../../../../modules/security/index.js';
import { calculateBackoffDelay, makeHttpError } from '../../../../../../modules/shared/index.js';

import { createOutboundCall } from './calls/outbound-call.js';
import { endCall } from './calls/end-call.js';
import { handleMediaConnection } from './media/media-connection.js';
import { persistCallLogs } from './logging/persist-call-logs.js';
import { getRecordingDownloadRequest } from './recordings/recording-download.js';
import {
  buildTwiMLConnectStream,
  computeRequestSignature,
  makeProviderConfigError,
  makeUnauthorizedError,
  sleepUnref,
  splitMediaWsUrl
} from './shared.js';
import { transferCall } from './calls/transfer-call.js';

export default class TwilioVoiceCompat {
  private async fetchJsonWithRetry(options: {
    url: string;
    headers: Record<string, string>;
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  }): Promise<any> {
    const maxRetries = Math.max(0, Math.floor(options.maxRetries));
    const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs));
    const maxDelayMs = Math.max(0, Math.floor(options.maxDelayMs));

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.fetchJson(options.url, options.headers);
      } catch (err: any) {
        const status = typeof err?.status === 'number' ? err.status : undefined;
        const retryable = status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
        if (!retryable || attempt >= maxRetries) {
          throw err;
        }

        const delayMs = calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs);
        await (sleepUnref(delayMs) ?? Promise.resolve());
        attempt += 1;
      }
    }
  }

  private async fetchJson(url: string, headers: Record<string, string>): Promise<any> {
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const error: any = new Error(`Request failed (${res.status})`);
      error.status = res.status;
      error.body = text;
      throw error;
    }

    try {
      return await res.json();
    } catch (err: any) {
      const error: any = new Error('Malformed response: invalid JSON');
      error.status = res.status;
      error.cause = err;
      throw error;
    }
  }

  private async fetchPaginatedJson(options: {
    initialUrl: string;
    headers: Record<string, string>;
    apiBaseUrl: string;
    maxPages: number;
    retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
  }): Promise<{ pages: any[] }> {
    const pages: any[] = [];
    let url: string | null = options.initialUrl;
    const maxPages = Math.max(1, Math.floor(options.maxPages));
    const seen = new Set<string>();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!url) break;

      if (pages.length >= maxPages) {
        break;
      }

      if (seen.has(url)) {
        break;
      }
      seen.add(url);

      const json = await this.fetchJsonWithRetry({
        url,
        headers: options.headers,
        ...options.retry
      });
      pages.push(json);

      const nextRaw = (json as any)?.next_page_uri;
      const next = typeof nextRaw === 'string' ? nextRaw.trim() : '';
      if (!next) break;

      url = next.startsWith('http://') || next.startsWith('https://')
        ? next
        : `${options.apiBaseUrl.replace(/\/+$/g, '')}${next.startsWith('/') ? '' : '/'}${next}`;
    }

    return { pages };
  }

  private writeJsonFile(filePath: string, data: any): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async persistCallLogs(options: {
    callConfigId: string;
    providerCallId: string;
    providerDefaults?: any;
    logger?: any;
  }): Promise<void> {
    return persistCallLogs({
      ...options,
      fetchJsonWithRetry: this.fetchJsonWithRetry.bind(this),
      fetchPaginatedJson: this.fetchPaginatedJson.bind(this),
      writeJsonFile: this.writeJsonFile.bind(this)
    });
  }

  async validateWebhookRequest(options: {
    req: http.IncomingMessage;
    url: string;
    params?: Record<string, string>;
    providerDefaults?: any;
  }): Promise<void> {
    const defaultsRaw = options.providerDefaults;
    const defaults =
      defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
        ? defaultsRaw
        : {};

    const authToken = String((defaults as any).authToken ?? '').trim();
    if (!authToken) {
      throw makeProviderConfigError('Missing required provider credentials');
    }

    const signatureHeader = options.req?.headers?.['x-twilio-signature'];
    const signature =
      typeof signatureHeader === 'string'
        ? signatureHeader.trim()
        : Array.isArray(signatureHeader)
          ? String(signatureHeader[0] ?? '').trim()
          : '';

    if (!signature) {
      throw makeUnauthorizedError('Unauthorized: missing signature');
    }

    const params = options.params && typeof options.params === 'object' ? options.params : {};
    const expected = computeRequestSignature(authToken, String(options.url), params);
    if (!safeEqual(signature, expected)) {
      throw makeUnauthorizedError('Unauthorized: invalid signature');
    }
  }

  async parseRecordingWebhook(options: {
    params?: Record<string, string>;
    callConfig?: any;
    providerDefaults?: any;
  }): Promise<{ recordingId: string; recordingUrl: string; recordingStatus?: string; providerCallId?: string }> {
    const params = options.params && typeof options.params === 'object' ? options.params : {};

    const recordingId = String(params.RecordingSid ?? params.recordingSid ?? '').trim();
    const recordingUrl = String(params.RecordingUrl ?? params.recordingUrl ?? '').trim();
    const recordingStatus = String(params.RecordingStatus ?? params.recordingStatus ?? '').trim();
    const providerCallId = String(params.CallSid ?? params.callSid ?? options.callConfig?.providerCallId ?? '').trim();

    if (!recordingId || !recordingUrl) {
      throw makeHttpError({ message: 'Missing recording fields', statusCode: 400, code: 'validation_error' });
    }

    let parsed: URL;
    try {
      parsed = new URL(recordingUrl);
    } catch {
      throw makeHttpError({ message: 'Invalid recordingUrl', statusCode: 400, code: 'validation_error' });
    }

    if (parsed.protocol !== 'https:') {
      throw makeHttpError({ message: 'Invalid recordingUrl protocol', statusCode: 400, code: 'validation_error' });
    }

    const defaultsRaw = options.providerDefaults;
    const defaults =
      defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
        ? defaultsRaw
        : {};

    const apiBaseUrlRaw = String((defaults as any).apiBaseUrl ?? 'https://api.twilio.com').trim();
    const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.twilio.com';
    let allowedOrigin: string;
    try {
      allowedOrigin = new URL(apiBaseUrl).origin;
    } catch {
      throw makeProviderConfigError('Invalid apiBaseUrl');
    }

    if (parsed.origin !== allowedOrigin) {
      throw makeHttpError({ message: 'Invalid recordingUrl origin', statusCode: 400, code: 'validation_error' });
    }

    return {
      recordingId,
      recordingUrl: parsed.toString(),
      ...(recordingStatus ? { recordingStatus } : {}),
      ...(providerCallId ? { providerCallId } : {})
    };
  }

  async createWebhookResponse(options: {
    req: http.IncomingMessage;
    callConfigId: string;
    callConfig: any;
    voiceProvider: string;
    mediaWsUrl: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const callConfigId = String(options.callConfigId);
    const callConfig = options.callConfig ?? {};
    const to = typeof callConfig.to === 'string' ? callConfig.to : '';
    const from = typeof callConfig.from === 'string' ? callConfig.from : '';
    const direction = String(callConfig.direction ?? '');

    const split = splitMediaWsUrl(String(options.mediaWsUrl));

    const xml = buildTwiMLConnectStream({
      wsUrl: split.wsUrl,
      parameters: {
        callConfigId,
        to,
        from,
        direction,
        voiceMediaToken: split.token
      }
    });

    return {
      status: 200,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: xml
    };
  }

  async handleMediaConnection(options: {
    ws: any;
    req: http.IncomingMessage;
    callConfigId: string;
    callConfig: any;
    voiceProvider: string;
    registry: any;
    providerDefaults?: any;
    events?: { emit?: (event: any) => void };
    logger?: any;
    metrics?: any;
  }): Promise<void> {
    return handleMediaConnection({
      ...options,
      endCall: this.endCall.bind(this),
      persistCallLogs: this.persistCallLogs.bind(this)
    });
  }

  async createOutboundCall(options: {
    to: string;
    from: string;
    callConfigId: string;
    callConfig?: any;
    mediaWsUrl: string;
    recordingStatusCallbackUrl?: string;
    providerDefaults?: any;
  }): Promise<{ providerCallId: string }> {
    return createOutboundCall(options);
  }

  async endCall(options: { providerCallId: string; providerDefaults?: any }): Promise<{ ok: true }> {
    return endCall(options);
  }

  async transferCall(options: {
    providerCallId: string;
    targetNumber: string;
    callerId?: string;
    timeout: number;
    providerDefaults?: any;
  }): Promise<{ ok: true }> {
    return transferCall(options);
  }

  async getRecordingDownloadRequest(options: { callConfigId: string; callConfig: any; providerDefaults?: any }): Promise<{ url: string; headers: Record<string, string> }> {
    return getRecordingDownloadRequest(options);
  }
}
