import fs from 'fs';

import { makeHttpError } from '../../../../../../../modules/shared/index.js';
import { mapErrorToHttp } from '../../../../../../../modules/transport/index.js';

import type { VoiceCliDeps } from './types.js';

export function parseJsonOrThrow(raw: string, context: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    throw makeHttpError({ message: `Invalid JSON ${context}`, statusCode: 400, code: 'invalid_json' });
  }
}

export async function readAllUtf8(stream: NodeJS.ReadableStream): Promise<string> {
  let input = '';
  stream.setEncoding('utf-8');
  for await (const chunk of stream) {
    input += chunk;
  }
  return input;
}

export async function readOptionalSystemPrompt(options: {
  systemPrompt?: unknown;
  systemPromptFile?: unknown;
  stdin: NodeJS.ReadableStream;
}): Promise<string | undefined> {
  if (options.systemPrompt !== undefined) {
    const value = String(options.systemPrompt);
    return value;
  }

  if (options.systemPromptFile !== undefined) {
    const filePath = String(options.systemPromptFile);
    return fs.readFileSync(filePath, 'utf-8');
  }

  const stdinIsTty = Boolean((options.stdin as any)?.isTTY);
  if (stdinIsTty) return undefined;

  const value = await readAllUtf8(options.stdin);
  const trimmed = value.trim();
  return trimmed ? value : undefined;
}

export function readRequiredTrimmed(value: unknown, field: string): string {
  const s = String(value ?? '').trim();
  if (!s) {
    throw makeHttpError({ message: `Missing ${field}`, statusCode: 400, code: 'validation_error' });
  }
  return s;
}

export function readOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function readOptionalJsonObject(options: {
  json?: unknown;
  jsonFile?: unknown;
  context: string;
}): any | undefined {
  if (options.jsonFile !== undefined) {
    const filePath = String(options.jsonFile);
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parseJsonOrThrow(raw, `in file '${filePath}'`);
  }
  if (options.json !== undefined) {
    return parseJsonOrThrow(String(options.json), `in ${options.context}`);
  }
  return undefined;
}

export async function writeJson(stdout: NodeJS.WritableStream, value: unknown, options: { pretty: boolean }) {
  const text = options.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await new Promise<void>(resolve => (stdout as any).write(text + '\n', () => resolve()));
}

export async function writeStructuredError(deps: VoiceCliDeps, error: any) {
  const mapped = mapErrorToHttp(error);
  deps.error(JSON.stringify(mapped.body));
}

