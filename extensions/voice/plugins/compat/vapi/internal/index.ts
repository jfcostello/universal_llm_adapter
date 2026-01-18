import type http from 'http';

import { createOutboundCall } from './outbound-call.js';
import { endCall } from './end-call.js';
import { getRecordingDownloadRequest } from './recording.js';
import { createWebhookResponse } from './webhook-response.js';
import { validateWebhookRequest } from './webhook-auth.js';

export default class VapiVoiceCompat {
  async validateWebhookRequest(options: {
    req: http.IncomingMessage;
    method?: string;
    url?: string;
    bodyText?: string;
    providerDefaults?: any;
  }): Promise<void> {
    return validateWebhookRequest(options);
  }

  async createOutboundCall(options: {
    to: string;
    from: string;
    callConfigId: string;
    callConfig?: any;
    voiceProvider: string;
    mediaWsUrl: string;
    providerDefaults?: any;
  }): Promise<{ providerCallId: string }> {
    return createOutboundCall(options);
  }

  async createWebhookResponse(options: {
    callConfigId: string;
    callConfig?: any;
    voiceProvider: string;
    body?: any;
    bodyText?: string;
    events?: { emit?: (event: any) => void };
    registry?: any;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return createWebhookResponse(options);
  }

  async endCall(options: { callConfigId: string; callConfig?: any; providerCallId: string; voiceProvider: string; providerDefaults?: any }): Promise<void> {
    return endCall(options);
  }

  async getRecordingDownloadRequest(options: { callConfigId: string; callConfig: any; providerDefaults?: any }): Promise<{ url: string; headers: Record<string, string> }> {
    return getRecordingDownloadRequest(options);
  }

  async handleMediaConnection(options: { ws: any }) {
    try { options.ws?.close?.(); } catch {}
  }
}

