/**
 * Live-test logger for integration tests (`LLM_LIVE=1`).
 *
 * Logs full, raw request/response payloads to `tests/live/logs/` so tests can assert
 * on what was actually sent/received.
 *
 * This must remain provider-agnostic and side-effect-light (no work until called).
 */

import * as fs from 'fs';
import * as path from 'path';
import { redactJsonCredentials } from '../../security/index.js';

export interface LiveTestLogContext {
  correlationId?: string;
  testFile?: string;
  testName?: string;
}

const logsDir = path.join(process.cwd(), 'tests', 'live', 'logs');
const initializedLogFiles = new Set<string>();

function ensureLogsDir(): void {
  fs.mkdirSync(logsDir, { recursive: true });
}

function isServerTransport(): boolean {
  return String(process.env.LLM_LIVE_TRANSPORT || '').trim().toLowerCase() === 'server';
}

function resolveLogTarget(
  context?: LiveTestLogContext
): { logFile: string; testFileName: string; testName: string } {
  const testFileName = String(context?.testFile || process.env.TEST_FILE || 'unknown-test');
  const testName = String(context?.testName || process.env.LLM_TEST_NAME || 'unknown-test-name');
  const dateOnly = new Date().toISOString().split('T')[0];
  const logFile = path.join(logsDir, `${dateOnly}-${testFileName}.log`);
  return { logFile, testFileName, testName };
}

function initLogFileOnce(target: { logFile: string; testFileName: string; testName: string }): void {
  if (initializedLogFiles.has(target.logFile)) return;

  ensureLogsDir();

  // CLI mode is one-process-per-call; truncation keeps logs small and avoids flakiness on reruns.
  // Server mode is one-process-for-many-calls; never truncate.
  if (!isServerTransport()) {
    fs.writeFileSync(target.logFile, '');
  } else if (!fs.existsSync(target.logFile)) {
    fs.writeFileSync(target.logFile, '');
  }

  const now = new Date();
  const localTime = now.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });

  fs.appendFileSync(target.logFile, `=== Live Integration Test Run ===\n`);
  fs.appendFileSync(target.logFile, `Test File: ${target.testFileName}\n`);
  fs.appendFileSync(target.logFile, `Test Name: ${target.testName}\n`);
  fs.appendFileSync(target.logFile, `Started at: ${localTime}\n\n`);

  initializedLogFiles.add(target.logFile);
}

function redactHeaders(headers: Record<string, any>): Record<string, any> {
  const redacted = { ...(headers || {}) };

  if (typeof redacted.Authorization === 'string') {
    const match = redacted.Authorization.match(/Bearer (.+)/);
    if (match && match[1]) {
      const key = match[1];
      redacted.Authorization = `Bearer ***${key.slice(-4)}`;
    }
  }

  if (typeof redacted['x-api-key'] === 'string') {
    const key = redacted['x-api-key'];
    redacted['x-api-key'] = `***${key.slice(-4)}`;
  }

  if (typeof redacted['x-goog-api-key'] === 'string') {
    const key = redacted['x-goog-api-key'];
    redacted['x-goog-api-key'] = `***${key.slice(-4)}`;
  }

  return redacted;
}

function stringifyBody(body: any): string {
  try {
    return JSON.stringify(redactJsonCredentials(body), null, 2);
  } catch {
    return String(body);
  }
}

export function logRequest(
  data: {
    url: string;
    method: string;
    headers: Record<string, any>;
    body: any;
  },
  context?: LiveTestLogContext
): void {
  const target = resolveLogTarget(context);
  initLogFileOnce(target);

  const timestamp = new Date().toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });

  const separator = '\n' + '='.repeat(80) + '\n';
  const log = [
    separator,
    '>>> OUTGOING REQUEST >>>',
    separator,
    `Timestamp: ${timestamp}`,
    `Method: ${data.method}`,
    `URL: ${data.url}`,
    '',
    '--- HEADERS ---',
    JSON.stringify(redactHeaders(data.headers), null, 2),
    '',
    '--- BODY ---',
    stringifyBody(data.body),
    separator,
    ''
  ].join('\n');

  fs.appendFileSync(target.logFile, log);
}

export function logResponse(
  data: {
    status: number;
    statusText?: string;
    headers: Record<string, any>;
    body: any;
  },
  context?: LiveTestLogContext
): void {
  const target = resolveLogTarget(context);
  initLogFileOnce(target);

  const timestamp = new Date().toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });

  const separator = '\n' + '='.repeat(80) + '\n';
  const log = [
    separator,
    '<<< INCOMING RESPONSE <<<',
    separator,
    `Timestamp: ${timestamp}`,
    `Status: ${data.status} ${data.statusText || ''}`,
    '',
    '--- HEADERS ---',
    JSON.stringify(data.headers, null, 2),
    '',
    '--- BODY ---',
    stringifyBody(data.body),
    separator,
    ''
  ].join('\n');

  fs.appendFileSync(target.logFile, log);
}

export function logObservabilityEvent(
  data: {
    eventType: string;
    traceId?: string;
    generationId?: string;
    event: any;
  },
  context?: LiveTestLogContext
): void {
  const target = resolveLogTarget(context);
  initLogFileOnce(target);

  const timestamp = new Date().toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });

  const separator = '\n' + '='.repeat(80) + '\n';
  const correlationId = context?.correlationId ? String(context.correlationId) : '';
  const log = [
    separator,
    '>>> OBSERVABILITY EVENT >>>',
    separator,
    `Timestamp: ${timestamp}`,
    correlationId ? `CorrelationId: ${correlationId}` : null,
    data.traceId ? `TraceId: ${data.traceId}` : null,
    data.generationId ? `GenerationId: ${data.generationId}` : null,
    `Event Type: ${data.eventType}`,
    '',
    '--- BODY ---',
    stringifyBody(data.event),
    separator,
    ''
  ].filter(Boolean).join('\n');

  fs.appendFileSync(target.logFile, log);
}
