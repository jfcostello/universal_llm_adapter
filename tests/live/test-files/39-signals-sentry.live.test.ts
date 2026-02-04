import { spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';

import { withLiveEnv } from '@tests/helpers/live.ts';

const runLive = process.env.LLM_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;

const TEST_FILE = '39-signals-sentry';
const DIST_CLI = path.join(process.cwd(), 'dist', 'bin', 'cli.js');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSentryApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.SENTRY_HOST || '').trim();
  if (!raw) return 'https://sentry.io';

  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    try {
      const parsed = new URL(`https://${raw}`);
      return parsed.origin;
    } catch {
      return 'https://sentry.io';
    }
  }
}

async function fetchProjectDsn(options: {
  apiKey: string;
  orgSlug: string;
  projectSlug: string;
  baseUrl: string;
}): Promise<string> {
  const url = new URL(`/api/0/projects/${options.orgSlug}/${options.projectSlug}/keys/`, options.baseUrl);
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      Accept: 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sentry keys API failed: HTTP ${res.status} ${res.statusText} ${text}`.trim());
  }

  const keys = await res.json();
  const list: any[] = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    const dsn =
      (typeof key?.dsn?.public === 'string' && String(key.dsn.public).trim()) ||
      (typeof key?.dsn?.secret === 'string' && String(key.dsn.secret).trim());
    if (dsn) return String(dsn).trim();
  }

  throw new Error('Sentry keys API returned no DSN values');
}

async function runSignalsReportCli(options: { env: NodeJS.ProcessEnv; args: string[] }): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_CLI, ...options.args], {
      cwd: process.cwd(),
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseStructuredCliResponse(stdout: string): any {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  let lastParsed: any = null;
  let lastResponse: any = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      lastParsed = parsed;
      if (parsed?.type === 'response') {
        lastResponse = parsed.data;
      }
    } catch {
      // ignore non-JSON output
    }
  }

  if (lastResponse !== null) return lastResponse;
  if (lastParsed !== null) return lastParsed;

  // Fallback: best-effort parse last line.
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

async function waitForSentryEvent(options: {
  apiKey: string;
  orgSlug: string;
  projectSlug: string;
  baseUrl: string;
  eventId: string;
  expectToken: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;

  const url = new URL(
    `/api/0/projects/${options.orgSlug}/${options.projectSlug}/events/${options.eventId}/`,
    options.baseUrl
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Sentry event ${options.eventId} (timeout ${timeoutMs}ms)`);
    }

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/json'
      }
    });

    if (res.status === 404) {
      await sleep(2000);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Sentry event read-back failed: HTTP ${res.status} ${res.statusText} ${text}`.trim());
    }

    const body = await res.json().catch(() => null);
    const message = typeof body?.message === 'string' ? body.message : '';
    const title = typeof body?.title === 'string' ? body.title : '';
    const haystack = `${message}\n${title}`;
    expect(haystack).toContain(options.expectToken);
    return;
  }
}

describeLive(TEST_FILE, () => {
  test('exports a signal to Sentry as an Issue event (envelope) and verifies via API read-back', async () => {
    const apiKey = String(process.env.SENTRY_API_KEY || '').trim();
    const orgSlug = String(process.env.SENTRY_ORG_SLUG || '').trim();
    const projectSlug = String(process.env.SENTRY_PROJECT_SLUG || '').trim();
    const baseUrl = getSentryApiBaseUrl();

    expect(apiKey).toBeTruthy();
    expect(orgSlug).toBeTruthy();
    expect(projectSlug).toBeTruthy();

    const dsn = await fetchProjectDsn({ apiKey, orgSlug, projectSlug, baseUrl });

    const token = `SIG_SENTRY_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    const traceId = `trace-${Date.now()}`;
    const generationId = `gen-${Date.now()}`;
    const correlationId = `corr_${token}`;

    const env = withLiveEnv({
      TEST_FILE,
      LLM_ADAPTER_SIGNALS_ENABLED: '1',
      LLM_ADAPTER_SIGNALS_TARGETS: JSON.stringify([{ provider: 'sentry', providerConfig: { dsn } }])
    });

    const report = await runSignalsReportCli({
      env,
      args: [
        'signals',
        'report',
        '--trace-id',
        traceId,
        '--generation-id',
        generationId,
        '--level',
        'error',
        '--message',
        token,
        '--metadata',
        JSON.stringify({ correlationId }),
        '--plugins',
        './plugins'
      ]
    });

    expect(report.code).toBe(0);
    const result = parseStructuredCliResponse(report.stdout);
    expect(result?.queued).toBe(true);

    const sentryResult = Array.isArray(result?.results)
      ? result.results.find((r: any) => r && r.target === 'sentry')
      : null;
    expect(sentryResult?.eventId).toBeTruthy();

    const adapterEventId = String(sentryResult.eventId);
    const sentryEventId = adapterEventId.replace(/-/g, '').toLowerCase();

    await waitForSentryEvent({
      apiKey,
      orgSlug,
      projectSlug,
      baseUrl,
      eventId: sentryEventId,
      expectToken: token,
      timeoutMs: 90_000
    });
  }, 180_000);
});
