import fs from 'fs';
import path from 'path';

import { basicAuthHeader, sanitizeFsToken } from '../shared.js';

export async function persistCallLogs(options: {
  callConfigId: string;
  providerCallId: string;
  providerDefaults?: any;
  logger?: any;
  fetchJsonWithRetry: (options: { url: string; headers: Record<string, string>; maxRetries: number; baseDelayMs: number; maxDelayMs: number }) => Promise<any>;
  fetchPaginatedJson: (options: {
    initialUrl: string;
    headers: Record<string, string>;
    apiBaseUrl: string;
    maxPages: number;
    retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
  }) => Promise<{ pages: any[] }>;
  writeJsonFile: (filePath: string, data: any) => void;
}): Promise<void> {
  if (process.env.LLM_ADAPTER_DISABLE_FILE_LOGS === '1') return;
  const providerCallId = String(options.providerCallId ?? '').trim();
  if (!providerCallId) return;

  const defaultsRaw = options.providerDefaults;
  const defaults =
    defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
      ? defaultsRaw
      : {};

  const accountSid = String((defaults as any).accountSid ?? '').trim();
  const authToken = String((defaults as any).authToken ?? '').trim();
  if (!accountSid || !authToken) {
    // Best-effort: if credentials are missing, skip call log capture.
    return;
  }

  const apiBaseUrlRaw = String((defaults as any).apiBaseUrl ?? 'https://api.twilio.com').trim();
  const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.twilio.com';

  const headers = { Authorization: basicAuthHeader(accountSid, authToken) };

  let stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    const { createIsoFilenameStamp } = await import('../../../../../../../modules/logging/index.js');
    stamp = createIsoFilenameStamp();
  } catch {
    // best-effort
  }

  const dirName = `call-${sanitizeFsToken(providerCallId)}-${stamp}`;
  const callDir = path.join(process.cwd(), 'logs', 'voice', 'twilio', dirName);
  fs.mkdirSync(callDir, { recursive: true });

  const callUrl = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`;
  const eventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}/Events.json`;
  const recordingsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}/Recordings.json`;
  const debuggerEventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}/Debugger/Events.json`;

  const maxPages = (() => {
    const raw = process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_MAX_PAGES;
    const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
  })();
  const retry = {
    maxRetries: (() => {
      const raw = process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_MAX_RETRIES;
      const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
    })(),
    baseDelayMs: (() => {
      const raw = process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_RETRY_BASE_DELAY_MS;
      const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 250;
    })(),
    maxDelayMs: (() => {
      const raw = process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_RETRY_MAX_DELAY_MS;
      const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2000;
    })()
  };

  const safeLog = (level: 'debug' | 'info' | 'warning' | 'error', message: string, data?: any) => {
    try {
      const fn = options.logger?.[level];
      if (typeof fn === 'function') fn(message, data);
    } catch {}
  };

  const capture = async (name: string, fn: () => Promise<any>): Promise<void> => {
    try {
      const result = await fn();
      options.writeJsonFile(path.join(callDir, `${name}.json`), result);
    } catch (err: any) {
      // Best-effort: persist the failure so debugging is still possible.
      const status = typeof err?.status === 'number' ? err.status : undefined;
      options.writeJsonFile(path.join(callDir, `${name}.json`), {
        error: {
          message: err?.message ?? String(err),
          ...(status ? { status } : {}),
          ...(err?.body ? { body: String(err.body).slice(0, 10_000) } : {})
        }
      });

      safeLog('warning', `voice.twilio.call_logs.${name}_failed`, {
        callConfigId: String(options.callConfigId ?? ''),
        providerCallId,
        ...(status ? { status } : {}),
        message: err?.message ?? String(err)
      });
    }
  };

  await capture('call', async () => await options.fetchJsonWithRetry({ url: callUrl, headers, ...retry }));
  await capture('events', async () =>
    await options.fetchPaginatedJson({ initialUrl: eventsUrl, headers, apiBaseUrl, maxPages, retry })
  );
  await capture('recordings', async () =>
    await options.fetchPaginatedJson({ initialUrl: recordingsUrl, headers, apiBaseUrl, maxPages, retry })
  );
  await capture('debugger-events', async () =>
    await options.fetchPaginatedJson({ initialUrl: debuggerEventsUrl, headers, apiBaseUrl, maxPages, retry })
  );

  // Apply retention parity (best-effort).
  try {
    const { applyRetentionOnce } = await import('../../../../../../../modules/logging/index.js');
    const { VOICE_MAX_FILES, VOICE_MAX_AGE_DAYS } = await import('../../../../../modules/logger/index.js');
    applyRetentionOnce(path.join(process.cwd(), 'logs', 'voice', 'twilio'), {
      includeDirs: true,
      match: (d: any) => d.isDirectory() && d.name.startsWith('call-'),
      maxFiles: VOICE_MAX_FILES,
      maxAgeDays: VOICE_MAX_AGE_DAYS,
      exclude: [callDir]
    });
  } catch {
    // best-effort
  }
}
