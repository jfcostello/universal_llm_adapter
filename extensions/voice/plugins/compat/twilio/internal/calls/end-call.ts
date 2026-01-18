import { ProviderExecutionError } from '../../../../../../../kernel/index.js';
import { makeHttpError } from '../../../../../../../modules/shared/index.js';

import { basicAuthHeader, makeProviderConfigError } from '../shared.js';

export async function endCall(options: { providerCallId: string; providerDefaults?: any }): Promise<{ ok: true }> {
  const providerCallId = String(options.providerCallId ?? '').trim();
  if (!providerCallId) {
    throw makeHttpError({ message: 'Missing providerCallId', statusCode: 400, code: 'validation_error' });
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

  const url = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`;
  const form = new URLSearchParams();
  form.set('Status', 'completed');

  let res: any;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(accountSid, authToken),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
  } catch (err: any) {
    const detail = err?.message ? `: ${String(err.message).slice(0, 200)}` : '';
    throw new ProviderExecutionError('twilio', `Call terminate failed${detail}`, 502);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const suffix = text ? `: ${text.slice(0, 500)}` : '';
    throw new ProviderExecutionError('twilio', `Call terminate failed (${res.status})${suffix}`, res.status, res.status === 429);
  }

  return { ok: true };
}
