import { makeHttpError } from '../../../../../../modules/shared/index.js';

import { basicAuthHeader, makeProviderConfigError } from './shared.js';

export async function getRecordingDownloadRequest(options: { callConfigId: string; callConfig: any; providerDefaults?: any }): Promise<{ url: string; headers: Record<string, string> }> {
  const callConfig = options.callConfig ?? {};
  const recording = (callConfig as any)?.recording;
  const providerRecording = recording && typeof recording === 'object' ? (recording as any).providerRecording : undefined;
  const baseUrl = String(providerRecording?.url ?? '').trim();
  if (!baseUrl) {
    throw makeHttpError({ message: 'Recording is not ready', statusCode: 409, code: 'recording_not_ready' });
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

  const format = String((recording as any)?.format ?? 'mp3').trim().toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const channelsRaw = String((recording as any)?.channels ?? 'mono').trim().toLowerCase();
  const requestedChannels = channelsRaw === 'dual' ? '2' : undefined;

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw makeHttpError({ message: 'Invalid recording URL', statusCode: 500, code: 'provider_error' });
  }

  if (!url.pathname.endsWith(`.${format}`)) {
    url.pathname = `${url.pathname}.${format}`;
  }
  if (requestedChannels) {
    url.searchParams.set('RequestedChannels', requestedChannels);
  }

  return {
    url: url.toString(),
    headers: { Authorization: basicAuthHeader(accountSid, authToken) }
  };
}

