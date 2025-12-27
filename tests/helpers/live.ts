import path from 'path';
import fs from 'fs';
import { runCoordinator, runEmbeddingCoordinator, runVectorCoordinator, type CliResult } from '@tests/helpers/node-cli.ts';
import type { ContentPart, LLMResponse, Message } from './live-types.ts';

export function withLiveEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, LLM_LIVE: '1', ...overrides };
}

export function buildLogPathFor(testFileBase: string): string {
  const dateOnly = new Date().toISOString().split('T')[0];
  return path.join(process.cwd(), 'tests', 'live', 'logs', `${dateOnly}-${testFileBase}.log`);
}

export function redactionFoundIn(text: string): boolean {
  // Provider-agnostic: detect any redaction marker of the form ***XXXX
  return /\*{3}[A-Za-z0-9_-]{4}/.test(text);
}

export type BaseSpec = {
  messages: Message[];
  llmPriority: Array<{ provider: string; model: string }>;
  settings: Record<string, any>;
  tools?: any[];
  functionToolNames?: string[];
  mcpServers?: string[];
  vectorContext?: any;
  observability?: any;
  metadata?: Record<string, any>;
  toolChoice?: any;
  [key: string]: any;
};

export function makeSpec(base: BaseSpec): BaseSpec {
  return base; // pass-through helper for clarity/extensibility
}

/**
 * Merge test settings with config settings.
 * Config temperature always wins - tests should not override provider-specific temperature settings.
 * This allows providers with temperature restrictions to work correctly.
 */
export function mergeSettings(
  configSettings: Record<string, any>,
  testOverrides: Record<string, any>
): Record<string, any> {
  const result = { ...configSettings, ...testOverrides };
  // Config temperature always takes precedence - don't let tests override it
  if (configSettings.temperature !== undefined) {
    result.temperature = configSettings.temperature;
  } else if (testOverrides.temperature !== undefined) {
    // If config doesn't have temperature, don't add it from test overrides
    delete result.temperature;
  }

  const configProvider = configSettings.provider;
  const overrideProvider = testOverrides.provider;
  if (
    configProvider &&
    typeof configProvider === 'object' &&
    !Array.isArray(configProvider) &&
    overrideProvider &&
    typeof overrideProvider === 'object' &&
    !Array.isArray(overrideProvider)
  ) {
    result.provider = { ...configProvider, ...overrideProvider };
  }

  return result;
}

export function parseLogBodies(logPath: string): any[] {
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const bodies: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].includes('--- BODY ---')) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^={10,}$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      const jsonStr = buf.join('\n').trim();
      if (jsonStr.startsWith('{') || jsonStr.startsWith('[')) {
        try {
          bodies.push(JSON.parse(jsonStr));
        } catch {}
      }
    }
    i++;
  }
  return bodies;
}

export function parseStream(stdout: string): any[] {
  const events: any[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') events.push(obj);
    } catch {}
  }
  return events;
}

export function collectDeltaText(events: any[]): string {
  return events
    .filter(e => (e.type === 'delta' || e.type === 'DELTA') && typeof e.content === 'string')
    .map(e => e.content)
    .join('');
}

export function findDone(events: any[]): any | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'done') return events[i];
  }
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value as any)) {
    const v = (value as any)[key];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return value;
}

function cloneJson<T>(value: T): T {
  // Base specs are JSON-serializable by design.
  return typeof (globalThis as any).structuredClone === 'function'
    ? (globalThis as any).structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function buildUserMessage(input: string | { content: ContentPart[] } | ContentPart[]): Message {
  if (typeof input === 'string') {
    return { role: 'user', content: [{ type: 'text', text: input } as any] };
  }
  if (Array.isArray(input)) {
    return { role: 'user', content: input };
  }
  return { role: 'user', content: input.content };
}

function buildAssistantMessageFromResponse(response: LLMResponse): Message {
  return {
    role: 'assistant',
    content: Array.isArray(response?.content) ? response.content : []
  } as Message;
}

export async function runLlmOnce(options: {
  spec: BaseSpec;
  pluginsPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  testFileBase: string;
  testName?: string;
}): Promise<{ result: CliResult; response?: LLMResponse }> {
  const env = {
    ...(options.env ?? process.env),
    LLM_LIVE: '1',
    TEST_FILE: options.testFileBase,
    ...(options.testName ? { LLM_TEST_NAME: options.testName } : {})
  };

  const result = await runCoordinator({
    args: ['run', '--spec', JSON.stringify(options.spec), '--plugins', options.pluginsPath ?? './plugins'],
    cwd: options.cwd ?? process.cwd(),
    env
  });

  if (result.code !== 0) {
    return { result };
  }

  const payload = JSON.parse(result.stdout.trim());
  return { result, response: payload as LLMResponse };
}

export async function runLlmStreamOnce(options: {
  spec: BaseSpec;
  pluginsPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  testFileBase: string;
  testName?: string;
}): Promise<{ result: CliResult; events: any[]; done?: any }> {
  const env = {
    ...(options.env ?? process.env),
    LLM_LIVE: '1',
    TEST_FILE: options.testFileBase,
    ...(options.testName ? { LLM_TEST_NAME: options.testName } : {})
  };

  const result = await runCoordinator({
    args: ['stream', '--spec', JSON.stringify(options.spec), '--plugins', options.pluginsPath ?? './plugins'],
    cwd: options.cwd ?? process.cwd(),
    env
  });

  const events = parseStream(result.stdout);
  return { result, events, done: findDone(events) };
}

export async function runEmbeddingOnce(options: {
  spec: any;
  pluginsPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  testFileBase: string;
  testName?: string;
}): Promise<{ result: CliResult; response?: any }> {
  const env = {
    ...(options.env ?? process.env),
    LLM_LIVE: '1',
    TEST_FILE: options.testFileBase,
    ...(options.testName ? { LLM_TEST_NAME: options.testName } : {})
  };

  const result = await runEmbeddingCoordinator({
    args: ['run', '--spec', JSON.stringify(options.spec), '--plugins', options.pluginsPath ?? './plugins'],
    cwd: options.cwd ?? process.cwd(),
    env
  });

  if (result.code !== 0) {
    return { result };
  }

  const payload = JSON.parse(result.stdout.trim());
  return { result, response: payload };
}

export async function runVectorOnce(options: {
  spec: any;
  pluginsPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  testFileBase: string;
  testName?: string;
  command?: 'run' | 'stream';
}): Promise<{ result: CliResult; response?: any; events?: any[]; done?: any }> {
  const env = {
    ...(options.env ?? process.env),
    LLM_LIVE: '1',
    TEST_FILE: options.testFileBase,
    ...(options.testName ? { LLM_TEST_NAME: options.testName } : {})
  };

  const command = options.command ?? 'run';
  const result = await runVectorCoordinator({
    args: [command, '--spec', JSON.stringify(options.spec), '--plugins', options.pluginsPath ?? './plugins'],
    cwd: options.cwd ?? process.cwd(),
    env
  });

  if (result.code !== 0) {
    return { result };
  }

  if (command === 'stream') {
    const events = parseStream(result.stdout);
    return { result, events, done: findDone(events) };
  }

  const payload = JSON.parse(result.stdout.trim());
  return { result, response: payload };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function deleteVectorCollectionAndWaitForMissing(options: {
  store: string;
  collectionName: string;
  testFileBase: string;
  pluginsPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}): Promise<void> {
  const timeoutMs = Math.max(1000, Math.floor(options.timeoutMs ?? 30_000));
  const minDelayMs = Math.max(10, Math.floor(options.minDelayMs ?? 500));
  const maxDelayMs = Math.max(minDelayMs, Math.floor(options.maxDelayMs ?? 5000));

  const { result: deleteResult, response: deleteRes } = await runVectorOnce({
    testFileBase: options.testFileBase,
    testName: 'cleanup_delete_collection',
    pluginsPath: options.pluginsPath,
    env: options.env,
    cwd: options.cwd,
    spec: {
      operation: 'collections',
      store: options.store,
      input: {
        collectionOp: 'delete',
        collectionName: options.collectionName
      }
    }
  });

  if (deleteResult.code !== 0) {
    throw new Error(`Vector cleanup failed: delete collection exited with code ${deleteResult.code}`);
  }
  if (deleteRes?.success !== true) {
    throw new Error('Vector cleanup failed: delete collection did not succeed');
  }

  const start = Date.now();
  let delay = minDelayMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Vector cleanup failed: collection still exists after ${timeoutMs}ms`);
    }

    const { result: existsResult, response: existsRes } = await runVectorOnce({
      testFileBase: options.testFileBase,
      testName: 'cleanup_exists_collection',
      pluginsPath: options.pluginsPath,
      env: options.env,
      cwd: options.cwd,
      spec: {
        operation: 'collections',
        store: options.store,
        input: {
          collectionOp: 'exists',
          collectionName: options.collectionName
        }
      }
    });

    if (existsResult.code === 0 && existsRes && typeof existsRes.exists === 'boolean' && existsRes.exists === false) {
      return;
    }

    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(delay / 2)));
    await sleep(delay + jitter);
    delay = Math.min(maxDelayMs, Math.floor(delay * 1.5) + 1);
  }
}

export interface LiveTurnRunner {
  runTurn: (input: string | { content: ContentPart[] } | ContentPart[], name?: string) => Promise<{ result: CliResult; response?: LLMResponse }>;
  getMessages: () => Message[];
  reset: () => void;
}

export function createLiveTurnRunner(options: {
  baseSpec: BaseSpec;
  pluginsPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  testFileBase: string;
}): LiveTurnRunner {
  const frozenBase = deepFreeze(cloneJson(options.baseSpec));
  const { messages: baseMessages = [], ...baseConfig } = frozenBase;

  let messages: Message[] = cloneJson(baseMessages);

  const reset = () => {
    messages = cloneJson(baseMessages);
  };

  const getMessages = () => cloneJson(messages);

  const runTurn: LiveTurnRunner['runTurn'] = async (input, name) => {
    const userMessage = buildUserMessage(input);
    const nextMessages = [...messages, userMessage];

    const { result, response } = await runLlmOnce({
      spec: { ...(baseConfig as any), messages: nextMessages } as any,
      pluginsPath: options.pluginsPath,
      cwd: options.cwd,
      env: options.env,
      testFileBase: options.testFileBase,
      ...(name ? { testName: name } : {})
    });

    if (result.code === 0 && response) {
      const assistantMessage = buildAssistantMessageFromResponse(response);
      messages = [...nextMessages, assistantMessage];
    }

    return { result, response };
  };

  return { runTurn, getMessages, reset };
}
