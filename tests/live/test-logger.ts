/**
 * Test logger for live integration tests.
 * Logs FULL, UNMODIFIED, RAW request and response payloads.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Find project root (where package.json is) and use tests/live/logs from there
const currentFile = fileURLToPath(import.meta.url);
let projectRoot = path.dirname(currentFile);

// Walk up to find package.json
while (projectRoot !== path.dirname(projectRoot)) {
  if (fs.existsSync(path.join(projectRoot, 'package.json'))) {
    break;
  }
  projectRoot = path.dirname(projectRoot);
}

const logsDir = path.join(projectRoot, 'tests', 'live', 'logs');

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Generate log file name with date and test file name (no time to consolidate tests in same file)
const now = new Date();
const dateOnly = now.toISOString().split('T')[0]; // YYYY-MM-DD format
const testFileName = process.env.TEST_FILE || 'unknown-test';
const testName = process.env.LLM_TEST_NAME || 'unknown-test-name';
const logFile = path.join(logsDir, `${dateOnly}-${testFileName}.log`);

// Format timestamp using local machine time with timezone
const localTime = now.toLocaleString(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short'
});

// Initialize log file (always truncate to start fresh for each test run)
fs.writeFileSync(logFile, `=== Live Integration Test Run ===\n`);
fs.appendFileSync(logFile, `Test File: ${testFileName}\n`);
fs.appendFileSync(logFile, `Started at: ${localTime}\n\n`);

/**
 * Redact sensitive data from headers (show only last 4 chars of API keys)
 */
function redactHeaders(headers: Record<string, any>): Record<string, any> {
  const redacted = { ...headers };

  // Redact OpenAI-style Authorization header
  if (redacted.Authorization && typeof redacted.Authorization === 'string') {
    const match = redacted.Authorization.match(/Bearer (.+)/);
    if (match && match[1]) {
      const key = match[1];
      const last4 = key.slice(-4);
      redacted.Authorization = `Bearer ***${last4}`;
    }
  }

  // Redact Anthropic-style x-api-key header
  if (redacted['x-api-key'] && typeof redacted['x-api-key'] === 'string') {
    const key = redacted['x-api-key'];
    const last4 = key.slice(-4);
    redacted['x-api-key'] = `***${last4}`;
  }

  // Redact Google-style x-goog-api-key header
  if (redacted['x-goog-api-key'] && typeof redacted['x-goog-api-key'] === 'string') {
    const key = redacted['x-goog-api-key'];
    const last4 = key.slice(-4);
    redacted['x-goog-api-key'] = `***${last4}`;
  }

  return redacted;
}

/**
 * Log raw HTTP request details
 */
export function logRequest(data: {
  url: string;
  method: string;
  headers: Record<string, any>;
  body: any;
}) {
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
    JSON.stringify(data.body, null, 2),
    separator,
    ''
  ].join('\n');

  fs.appendFileSync(logFile, log);
  // Log to stderr to avoid polluting JSON output on stdout
  console.error(`[TEST LOG] Request logged to: ${logFile}`);
}

/**
 * Log raw HTTP response details
 */
export function logResponse(data: {
  status: number;
  statusText?: string;
  headers: Record<string, any>;
  body: any;
}) {
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
    JSON.stringify(data.body, null, 2),
    separator,
    ''
  ].join('\n');

  fs.appendFileSync(logFile, log);
  // Log to stderr to avoid polluting JSON output on stdout
  console.error(`[TEST LOG] Response logged to: ${logFile}`);
}

/**
 * Log general test information
 */
export function logInfo(message: string) {
  const timestamp = new Date().toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });
  const log = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logFile, log);
}

/**
 * Clean up old log files, keeping only the last N files
 */
export function cleanupOldLogs(keepLast: number = 30) {
  if (!fs.existsSync(logsDir)) return;

  const files = fs.readdirSync(logsDir)
    .filter(f => f.endsWith('.log'))
    .map(f => ({
      name: f,
      path: path.join(logsDir, f),
      mtime: fs.statSync(path.join(logsDir, f)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  // Delete files beyond the keepLast limit
  const toDelete = files.slice(keepLast);
  toDelete.forEach(file => {
    fs.unlinkSync(file.path);
  });

  if (toDelete.length > 0) {
    logInfo(`Cleaned up ${toDelete.length} old log files`);
  }
}

// Clean up old logs on import (keeps last 30)
cleanupOldLogs(30);

export { logFile };
