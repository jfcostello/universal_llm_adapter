import { ProviderExecutionError } from '../../../../../../../kernel/index.js';
import { makeHttpError, validateE164 } from '../../../../../../../modules/shared/index.js';

import { basicAuthHeader, buildTwiMLDial, makeProviderConfigError } from '../shared.js';

export async function transferCall(options: {
  providerCallId: string;
  targetNumber: string;
  callerId?: string;
  timeout: number;
  providerDefaults?: any;
}): Promise<{ ok: true }> {
  const providerCallId = String(options.providerCallId ?? '').trim();
  if (!providerCallId) {
    throw makeHttpError({ message: 'Missing providerCallId', statusCode: 400, code: 'validation_error' });
  }

  const targetNumberResult = validateE164(options.targetNumber);
  if (!targetNumberResult.ok) {
    throw makeHttpError({ message: targetNumberResult.error, statusCode: 400, code: 'validation_error' });
  }
  const targetNumber = targetNumberResult.value;

  const callerIdRaw = options.callerId !== undefined ? String(options.callerId ?? '').trim() : undefined;
  // callerId validation is delegated to Twilio - we just pass it through if provided

  const timeoutRaw = options.timeout;
  const n = Number(timeoutRaw);
  if (!Number.isFinite(n) || n < 1 || n > 600) {
    throw makeHttpError({ message: 'Invalid timeout (must be 1-600 seconds)', statusCode: 400, code: 'validation_error' });
  }
  const timeout = Math.floor(n);

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

  const twiml = buildTwiMLDial({
    targetNumber,
    timeout,
    ...(callerIdRaw ? { callerId: callerIdRaw } : {})
  });

  const url = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`;
  const form = new URLSearchParams();
  form.set('Twiml', twiml);

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
    throw new ProviderExecutionError('twilio', `Call transfer failed${detail}`, 502);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const suffix = text ? `: ${text.slice(0, 500)}` : '';
    throw new ProviderExecutionError('twilio', `Call transfer failed (${res.status})${suffix}`, res.status, res.status === 429);
  }

  return { ok: true };
}
