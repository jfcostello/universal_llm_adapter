import { ProviderExecutionError } from '../../../../../../kernel/index.js';
import { makeHttpError } from '../../../../../../modules/shared/index.js';

import { basicAuthHeader, buildTwiMLConnectStream, makeProviderConfigError, splitMediaWsUrl } from './shared.js';

export async function createOutboundCall(options: {
  to: string;
  from: string;
  callConfigId: string;
  callConfig?: any;
  mediaWsUrl: string;
  recordingStatusCallbackUrl?: string;
  providerDefaults?: any;
}): Promise<{ providerCallId: string }> {
  const to = String(options.to ?? '').trim();
  const from = String(options.from ?? '').trim();
  const callConfigId = String(options.callConfigId ?? '').trim();
  if (!to || !from || !callConfigId) {
    throw makeHttpError({ message: 'Missing required fields for outbound call', statusCode: 400, code: 'validation_error' });
  }

  const defaultsRaw = options.providerDefaults;
  const defaults =
    defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
      ? defaultsRaw
      : {};

  const accountSid = String((defaults as any).accountSid ?? '').trim();
  const authToken = String((defaults as any).authToken ?? '').trim();
  if (!accountSid || !authToken) {
    throw makeProviderConfigError('Missing required provider credentials');
  }

  const apiBaseUrlRaw = String((defaults as any).apiBaseUrl ?? 'https://api.twilio.com').trim();
  const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.twilio.com';

  const outbound = (defaults as any).outbound ?? {};
  const mode = String(outbound?.mode ?? 'twiml').trim().toLowerCase();
  const outboundTimeoutMsRaw = outbound?.timeoutMs;
  const outboundTimeoutMs =
    outboundTimeoutMsRaw === undefined || outboundTimeoutMsRaw === null || outboundTimeoutMsRaw === ''
      ? 15000
      : Number(outboundTimeoutMsRaw);
  if (!Number.isFinite(outboundTimeoutMs) || outboundTimeoutMs <= 0) {
    throw makeProviderConfigError('Invalid outbound timeoutMs');
  }

  const form = new URLSearchParams();
  form.set('To', to);
  form.set('From', from);

  const callConfig = options.callConfig ?? {};
  const timeouts = (callConfig as any)?.timeouts;
  const callTimeoutMsRaw = (timeouts as any)?.callTimeoutMs;
  const callTimeoutMs = callTimeoutMsRaw === undefined || callTimeoutMsRaw === null || callTimeoutMsRaw === '' ? undefined : Number(callTimeoutMsRaw);
  if (callTimeoutMs !== undefined) {
    if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) {
      throw makeHttpError({ message: 'Invalid timeouts.callTimeoutMs', statusCode: 400, code: 'validation_error' });
    }
    const seconds = Math.max(1, Math.ceil(callTimeoutMs / 1000));
    form.set('TimeLimit', String(seconds));
  }

  const recording = (callConfig as any)?.recording;
  const recordingEnabled = Boolean(recording && typeof recording === 'object' && (recording as any).enabled === true);
  const recordingMode = recordingEnabled ? String((recording as any).mode ?? 'provider') : '';
  if (recordingEnabled && recordingMode === 'provider') {
    form.set('Record', 'true');

    const channelsRaw = String((recording as any).channels ?? 'mono').trim().toLowerCase();
    const channels = channelsRaw === 'dual' ? 'dual' : 'mono';
    form.set('RecordingChannels', channels);

    const callbackUrl = String(options.recordingStatusCallbackUrl ?? '').trim();
    if (callbackUrl) {
      form.set('RecordingStatusCallback', callbackUrl);
      form.set('RecordingStatusCallbackEvent', 'completed');
    }
  }

  if (mode === 'url') {
    const baseUrl = String(outbound?.webhookUrl ?? '').trim();
    if (!baseUrl) {
      throw makeProviderConfigError('Missing outbound webhookUrl for url mode');
    }
    const url = new URL(baseUrl);
    url.searchParams.set('callConfigId', callConfigId);
    form.set('Url', url.toString());
  } else if (mode === 'twiml') {
    const split = splitMediaWsUrl(String(options.mediaWsUrl));
    const twiml = buildTwiMLConnectStream({
      wsUrl: split.wsUrl,
      parameters: { callConfigId, to, from, direction: 'outbound', voiceMediaToken: split.token }
    });
    form.set('Twiml', twiml);
  } else {
    throw makeProviderConfigError(`Unsupported outbound mode '${mode}'`);
  }

  const url = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.floor(outboundTimeoutMs));

  let res: any;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(accountSid, authToken),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString(),
      signal: controller.signal
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new ProviderExecutionError('twilio', `Outbound call create timed out after ${Math.floor(outboundTimeoutMs)}ms`, 504);
    }
    const detail = err?.message ? `: ${String(err.message).slice(0, 200)}` : '';
    throw new ProviderExecutionError('twilio', `Outbound call create failed${detail}`, 502);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const suffix = text ? `: ${text.slice(0, 500)}` : '';
    throw new ProviderExecutionError('twilio', `Outbound call create failed (${res.status})${suffix}`, res.status, res.status === 429);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new ProviderExecutionError('twilio', 'Malformed response: invalid JSON', res.status);
  }

  const sid = String(data?.sid ?? '').trim();
  if (!sid) {
    throw new ProviderExecutionError('twilio', 'Malformed response: missing sid', res.status);
  }

  return { providerCallId: sid };
}

