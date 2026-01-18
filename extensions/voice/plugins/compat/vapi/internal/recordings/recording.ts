import { ProviderExecutionError } from '../../../../../../../kernel/index.js';
import { makeHttpError } from '../../../../../../../modules/shared/index.js';

import { makeProviderConfigError, normalizePlainObject } from '../shared.js';

function normalizeRecordingChannels(value: any): 'mono' | 'dual' {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'dual' ? 'dual' : 'mono';
}

function resolveRecordingDownloadUrl(call: any, channels: 'mono' | 'dual'): string {
  const callObj = normalizePlainObject(call);
  const artifact = normalizePlainObject(callObj.artifact);

  const recordingFromArtifact = artifact.recording;
  const recObj = normalizePlainObject(recordingFromArtifact);
  const monoObj = normalizePlainObject(recObj.mono);

  const candidates: any[] = [];
  if (channels === 'dual') {
    candidates.push(recObj.stereoUrl, artifact.stereoRecordingUrl, callObj.stereoRecordingUrl);
  }
  candidates.push(monoObj.combinedUrl, recordingFromArtifact, artifact.recordingUrl, callObj.recordingUrl);
  if (channels !== 'dual') {
    candidates.push(recObj.stereoUrl, artifact.stereoRecordingUrl, callObj.stereoRecordingUrl);
  }

  for (const candidate of candidates) {
    const url = typeof candidate === 'string' ? candidate.trim() : '';
    if (url) return url;
  }
  return '';
}

export async function getRecordingDownloadRequest(options: { callConfigId: string; callConfig: any; providerDefaults?: any }): Promise<{ url: string; headers: Record<string, string> }> {
  const callConfig = options.callConfig ?? {};

  const providerCallId = String((callConfig as any)?.providerCallId ?? '').trim();
  if (!providerCallId) {
    throw makeHttpError({ message: 'Recording is not ready', statusCode: 409, code: 'recording_not_ready' });
  }

  const defaults = normalizePlainObject(options.providerDefaults);
  const apiKey = String(defaults.apiKey ?? '').trim();
  const apiBaseUrlRaw = String(defaults.apiBaseUrl ?? 'https://api.vapi.ai').trim();
  const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.vapi.ai';
  if (!apiKey) {
    throw makeProviderConfigError('Missing required provider credentials');
  }

  let apiHost = '';
  try {
    apiHost = new URL(apiBaseUrl).host;
  } catch {
    throw makeProviderConfigError('Invalid provider apiBaseUrl');
  }

  const channels = normalizeRecordingChannels((callConfig as any)?.recording?.channels);
  const url = `${apiBaseUrl}/call/${encodeURIComponent(providerCallId)}`;

  let res: any;
  try {
    res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (err: any) {
    const detail = err?.message ? `: ${String(err.message).slice(0, 200)}` : '';
    throw new ProviderExecutionError('vapi', `Call get failed${detail}`, 502);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const suffix = text ? `: ${text.slice(0, 500)}` : '';
    throw new ProviderExecutionError('vapi', `Call get failed (${res.status})${suffix}`, res.status, res.status === 429);
  }

  const call = await res.json().catch(() => null);
  const recordingUrlRaw = resolveRecordingDownloadUrl(call, channels);
  if (!recordingUrlRaw) {
    throw makeHttpError({ message: 'Recording is not ready', statusCode: 409, code: 'recording_not_ready' });
  }

  let recordingUrl: URL;
  try {
    recordingUrl = new URL(recordingUrlRaw);
  } catch {
    throw makeHttpError({ message: 'Invalid recording URL', statusCode: 500, code: 'provider_error' });
  }
  if (recordingUrl.protocol !== 'https:' && recordingUrl.protocol !== 'http:') {
    throw makeHttpError({ message: 'Invalid recording URL protocol', statusCode: 500, code: 'provider_error' });
  }

  const headers: Record<string, string> = {};
  if (recordingUrl.host === apiHost) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return { url: recordingUrl.toString(), headers };
}
