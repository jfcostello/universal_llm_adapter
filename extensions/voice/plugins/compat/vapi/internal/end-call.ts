import { ProviderExecutionError } from '../../../../../../kernel/index.js';

import { makeProviderConfigError, normalizePlainObject } from './shared.js';

export async function endCall(options: { callConfigId: string; callConfig?: any; providerCallId: string; voiceProvider: string; providerDefaults?: any }): Promise<void> {
  const providerCallId = String(options.providerCallId ?? options.callConfig?.providerCallId ?? '').trim();
  if (!providerCallId) return;

  const defaults = normalizePlainObject(options.providerDefaults);
  const apiKey = String(defaults.apiKey ?? '').trim();
  const apiBaseUrlRaw = String(defaults.apiBaseUrl ?? 'https://api.vapi.ai').trim();
  const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.vapi.ai';
  if (!apiKey) {
    throw makeProviderConfigError('Missing required provider credentials');
  }

  const callUrl = `${apiBaseUrl}/call/${encodeURIComponent(providerCallId)}`;
  const pollMsRaw = defaults.controlUrlPollMs ?? 500;
  const maxWaitMsRaw = defaults.controlUrlMaxWaitMs ?? 20000;
  const pollMs = Math.max(100, Math.floor(Number.isFinite(Number(pollMsRaw)) ? Number(pollMsRaw) : 500));
  const maxWaitMs = Math.max(pollMs, Math.floor(Number.isFinite(Number(maxWaitMsRaw)) ? Number(maxWaitMsRaw) : 20000));

  const deadline = Date.now() + maxWaitMs;
  let controlUrl = '';
  let lastErr: any;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(callUrl, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Vapi call get failed (${res.status}): ${text || res.statusText}`);
      }
      const json = await res.json().catch(() => ({}));
      const monitor = normalizePlainObject((json as any)?.monitor);
      controlUrl = String(monitor.controlUrl ?? '').trim();
      if (controlUrl) break;
    } catch (err: any) {
      lastErr = err;
    }

    await new Promise<void>(resolve => setTimeout(resolve, pollMs));
  }

  if (!controlUrl) {
    const detail = lastErr?.message ? `: ${String(lastErr.message).slice(0, 200)}` : '';
    throw new ProviderExecutionError('vapi', `Vapi controlUrl unavailable${detail}`, 502);
  }

  const res = await fetch(controlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'end-call' }) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderExecutionError('vapi', `Vapi control failed (${res.status}): ${text || res.statusText}`, res.status, res.status === 429);
  }
}

