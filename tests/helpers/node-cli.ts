import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { DIST_DIR } from './paths.ts';

export interface CliRunOptions {
  args?: string[];
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  logs: string[];
}

function getTransport(env: NodeJS.ProcessEnv | undefined): 'cli' | 'server' {
  const raw = String(env?.LLM_LIVE_TRANSPORT || process.env.LLM_LIVE_TRANSPORT || 'cli')
    .trim()
    .toLowerCase();
  return raw === 'server' ? 'server' : 'cli';
}

type ToolTarget = 'llm' | 'vector' | 'embedding';

function getUnifiedCliScript(): string {
  return path.join(DIST_DIR, 'bin', 'cli.js');
}

function getTargetCommand(target: ToolTarget): string[] {
  switch (target) {
    case 'llm':
      // LLM commands (run, stream) are at the root level of the unified CLI
      return [];
    case 'vector':
      return ['vector'];
    case 'embedding':
      return ['embeddings'];
  }
}

function getTargetEndpoint(target: ToolTarget, command: string): string | null {
  if (command === 'run') {
    if (target === 'llm') return '/run';
    if (target === 'vector') return '/vector/run';
    if (target === 'embedding') return '/embeddings/run';
  }

  if (command === 'stream') {
    if (target === 'llm') return '/stream';
    if (target === 'vector') return '/vector/stream';
  }

  return null;
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1) {
    const next = args[idx + 1];
    return next ? String(next) : undefined;
  }

  const prefix = `${flag}=`;
  const eq = args.find(a => a.startsWith(prefix));
  if (!eq) return undefined;
  return String(eq.slice(prefix.length));
}

function findSpecFromArgs(options: CliRunOptions): { spec: any; args: string[] } {
  const args = [...(options.args ?? ['run'])];
  const cwd = options.cwd || process.cwd();

  const filePath = parseFlagValue(args, '--file');
  const specJson = parseFlagValue(args, '--spec');

  if (filePath) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const content = fs.readFileSync(resolved, 'utf-8');
    return { spec: JSON.parse(content), args };
  }

  if (specJson) {
    return { spec: JSON.parse(specJson), args };
  }

  if (options.stdin) {
    return { spec: JSON.parse(options.stdin), args };
  }

  throw new Error('No spec provided (expected --spec, --file, or stdin)');
}

function sanitizeId(value: string, maxLen: number = 180): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'unknown';

  const normalized = raw
    .normalize('NFKD')
    .replace(/[^\w]+/g, '-') // Keep letters/numbers/_ and convert everything else to '-'
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) return 'unknown';
  if (normalized.length <= maxLen) return normalized;

  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 10);
  const prefixLen = Math.max(1, maxLen - (hash.length + 1));
  return `${normalized.slice(0, prefixLen)}-${hash}`;
}

function readProviderAndModelFromSpec(spec: any): { provider?: string; model?: string } {
  if (!spec || typeof spec !== 'object') return {};

  const llmPriority = Array.isArray(spec.llmPriority) ? spec.llmPriority : [];
  for (const entry of llmPriority) {
    if (!entry || typeof entry !== 'object') continue;
    const provider = typeof (entry as any).provider === 'string' ? String((entry as any).provider) : undefined;
    const model = typeof (entry as any).model === 'string' ? String((entry as any).model) : undefined;
    if (!provider && !model) continue;
    // Tests sometimes prepend an intentionally invalid entry to exercise fallback behavior.
    if (provider === 'nonexistent-provider') continue;
    return { provider, model };
  }

  const provider = typeof spec.provider === 'string' ? spec.provider : undefined;
  const model = typeof spec.model === 'string' ? spec.model : undefined;
  if (provider || model) return { provider, model };

  const firstEmbedding = Array.isArray(spec.embeddingPriority) ? spec.embeddingPriority[0] : undefined;
  if (firstEmbedding && typeof firstEmbedding === 'object') {
    const embeddingProvider = typeof firstEmbedding.provider === 'string' ? firstEmbedding.provider : undefined;
    const embeddingModel = typeof firstEmbedding.model === 'string' ? firstEmbedding.model : undefined;
    if (embeddingProvider || embeddingModel) return { provider: embeddingProvider, model: embeddingModel };
  }

  const store = typeof spec.store === 'string' ? spec.store : undefined;
  if (store) return { provider: store };

  return {};
}

function buildLiveCorrelationId(spec: any, env: NodeJS.ProcessEnv): string {
  const testFile = String(env.TEST_FILE || 'unknown-test').trim() || 'unknown-test';
  const testName = env.LLM_TEST_NAME ? String(env.LLM_TEST_NAME).trim() : '';
  const { provider, model } = readProviderAndModelFromSpec(spec);

  const parts = [testFile, testName, provider ?? '', model ?? ''].filter(Boolean);
  return sanitizeId(parts.join('-'));
}

function injectLiveMetadata(spec: any, env: NodeJS.ProcessEnv): { spec: any; correlationId: string } {
  const isLive = String(env.LLM_LIVE || '').trim() === '1';
  const testFile = String(env.TEST_FILE || 'unknown-test');
  const testName = env.LLM_TEST_NAME ? String(env.LLM_TEST_NAME) : undefined;

  const correlationId = isLive
    ? buildLiveCorrelationId(spec, env)
    : String(spec?.metadata?.correlationId || '').trim();

  const next = { ...(spec ?? {}) };
  const existingTags = Array.isArray((next.metadata as any)?.tags) ? (next.metadata as any).tags : [];
  const { provider, model } = isLive ? readProviderAndModelFromSpec(spec) : {};
  const transport = String(env.LLM_LIVE_TRANSPORT || '').trim().toLowerCase();
  const liveTags = isLive
    ? [
        testFile,
        ...(testName ? [testName] : []),
        ...(transport ? [`transport:${transport}`] : []),
        ...(provider ? [`provider:${provider}`] : []),
        ...(model ? [`model:${model}`] : [])
      ]
    : [];
  const tags = [...existingTags, ...liveTags]
    .map((tag: any) => String(tag).trim())
    .filter(Boolean);
  const uniqueTags = Array.from(new Set(tags));
  next.metadata = {
    ...(next.metadata ?? {}),
    ...(correlationId ? { correlationId } : {}),
    testFile,
    ...(testName ? { testName } : {}),
    ...(uniqueTags.length > 0 ? { tags: uniqueTags } : {})
  };

  return { spec: next, correlationId: correlationId || '' };
}

async function readLogsForCorrelationId(options: {
  logPath?: string;
  correlationId: string;
  timeoutMs?: number;
}): Promise<string[]> {
  const logPath = options.logPath;
  if (!logPath) return [];

  const timeoutMs = options.timeoutMs ?? 10000;
  const settleMs = 250;
  const start = Date.now();
  const needle = `"correlationId":"${options.correlationId}"`;

  let lastMatches: string[] = [];
  let lastChangeAt = 0;

  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(logPath)) {
      await new Promise(res => setTimeout(res, 50));
      continue;
    }

    const text = fs.readFileSync(logPath, 'utf-8');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const matches = lines.filter(l => l.includes(needle));
    if (matches.length === 0) {
      await new Promise(res => setTimeout(res, 50));
      continue;
    }

    const changed =
      matches.length !== lastMatches.length || matches.some((line, idx) => line !== lastMatches[idx]);

    if (changed) {
      lastMatches = matches;
      lastChangeAt = Date.now();
      await new Promise(res => setTimeout(res, 50));
      continue;
    }

    if (lastChangeAt && Date.now() - lastChangeAt >= settleMs) {
      return lastMatches;
    }

    await new Promise(res => setTimeout(res, 50));
  }

  return lastMatches;
}

async function runToolViaServer(target: ToolTarget, options: CliRunOptions): Promise<CliResult> {
  const env = options.env || process.env;
  const serverUrl = env.LLM_TEST_SERVER_URL;
  if (!serverUrl) {
    return {
      stdout: '',
      stderr: JSON.stringify({ error: 'Missing LLM_TEST_SERVER_URL for server transport' }),
      code: 1,
      logs: []
    };
  }

  const serverApiKey = env.LLM_TEST_SERVER_API_KEY ?? env.LLM_TEST_REALTIME_API_KEY;
  const serverAuthHeaderName = 'x-api-key';

  const { spec: rawSpec, args } = findSpecFromArgs(options);
  const command = args[0] || 'run';

  const endpointPath = getTargetEndpoint(target, command);
  if (!endpointPath) {
    return {
      stdout: '',
      stderr: JSON.stringify({
        error: `Unsupported command for server transport: ${command}`,
        target
      }),
      code: 1,
      logs: []
    };
  }

  const batchIdFlag = parseFlagValue(args, '--batch-id');
  const runWideBatchId = env.LLM_LIVE_BATCH_ID;
  if (batchIdFlag && runWideBatchId && String(batchIdFlag) !== String(runWideBatchId)) {
    return {
      stdout: '',
      stderr: JSON.stringify({
        error: 'batch_id_mismatch',
        message: 'Server transport uses a run-wide batch id; per-call --batch-id must match LLM_LIVE_BATCH_ID',
        expected: runWideBatchId,
        got: batchIdFlag
      }),
      code: 1,
      logs: []
    };
  }

  const { spec, correlationId } = injectLiveMetadata(rawSpec, env);

  const authHeaders = serverApiKey
    ? { [serverAuthHeaderName]: String(serverApiKey) }
    : {};

  try {
    if (command === 'run') {
      const res = await fetch(new URL(endpointPath, serverUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(spec)
      });

      const text = await res.text();
      if (!res.ok) {
        const logs = await readLogsForCorrelationId({
          logPath: env.LLM_TEST_SERVER_PROCESS_LOG_PATH,
          correlationId
        });
        return { stdout: '', stderr: text, code: 1, logs };
      }

      const parsed = JSON.parse(text);
      const unwrapped = parsed?.type === 'response' ? parsed.data : parsed;

      const logs = await readLogsForCorrelationId({
        logPath: env.LLM_TEST_SERVER_PROCESS_LOG_PATH,
        correlationId
      });

      return { stdout: JSON.stringify(unwrapped), stderr: '', code: 0, logs };
    }

    // stream
    const res = await fetch(new URL(endpointPath, serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(spec)
    });

    if (!res.ok) {
      const text = await res.text();
      const logs = await readLogsForCorrelationId({
        logPath: env.LLM_TEST_SERVER_PROCESS_LOG_PATH,
        correlationId
      });
      return { stdout: '', stderr: text, code: 1, logs };
    }

    const events: string[] = [];
    let buffer = '';

    for await (const chunk of res.body as any) {
      buffer += Buffer.from(chunk).toString('utf-8');

      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const lines = rawEvent.split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice('data:'.length).trimStart();
          if (!payload || payload === '[DONE]') continue;
          events.push(payload);
        }
      }
    }

    const logs = await readLogsForCorrelationId({
      logPath: env.LLM_TEST_SERVER_PROCESS_LOG_PATH,
      correlationId
    });

    return { stdout: events.join('\n'), stderr: '', code: 0, logs };
  } catch (error: any) {
    const logs = await readLogsForCorrelationId({
      logPath: env.LLM_TEST_SERVER_PROCESS_LOG_PATH,
      correlationId
    });
    return {
      stdout: '',
      stderr: JSON.stringify({ error: error?.message ?? String(error) }),
      code: 1,
      logs
    };
  }
}

function runToolViaCli(target: ToolTarget, options: CliRunOptions = {}): Promise<CliResult> {
  const script = getUnifiedCliScript();
  const targetCmd = getTargetCommand(target);
  const rawArgs = options.args ?? ['run'];
  const env = options.env || process.env;
  const isLive = String(env.LLM_LIVE || '').trim() === '1';

  // Unified CLI: llm-adapter <target> <command> [options]
  // e.g., llm-adapter llm run --spec '...'
  // e.g., llm-adapter vector embed --spec '...'
  // e.g., llm-adapter embeddings run --spec '...'
  const args = (() => {
    if (!isLive) return [...targetCmd, ...rawArgs];

    const { spec: rawSpec, args: parsedArgs } = findSpecFromArgs({
      ...options,
      args: rawArgs
    });
    const { spec: injectedSpec } = injectLiveMetadata(rawSpec, env);

    const argsNoSpec = [...parsedArgs];
    for (const flag of ['--file', '--spec']) {
      while (true) {
        const idx = argsNoSpec.indexOf(flag);
        if (idx === -1) break;
        argsNoSpec.splice(idx, 2);
      }
      const prefix = `${flag}=`;
      for (let i = argsNoSpec.length - 1; i >= 0; i--) {
        if (String(argsNoSpec[i]).startsWith(prefix)) {
          argsNoSpec.splice(i, 1);
        }
      }
    }

    return [...targetCmd, ...argsNoSpec, '--spec', JSON.stringify(injectedSpec)];
  })();

  return new Promise((resolve) => {
    // Use process.execPath to ensure we use the same Node.js executable running the tests
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd || DIST_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      // Parse stdout: split by newlines, separate logs from response/stream events
      const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0);

      const responseLines: string[] = [];
      const logLines: string[] = [];

      // Iterate through lines and separate logs from response/events
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);

          // Log lines have type: "log"
          if (parsed.type === 'log') {
            logLines.push(line);
          }
          // Response has type: "response" - unwrap the data field
          else if (parsed.type === 'response') {
            // Unwrap: {type: "response", data: {...}} -> {...}
            const unwrapped = JSON.stringify(parsed.data);
            responseLines.push(unwrapped);
          }
          // Stream events and other types pass through as-is
          else {
            responseLines.push(line);
          }
        } catch {
          // Not JSON, treat as part of response
          responseLines.push(line);
        }
      }

      // Join response lines with newlines for stream output compatibility
      const responseOutput = responseLines.join('\n');

      resolve({
        stdout: responseOutput,
        stderr,
        code,
        logs: logLines
      });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export function runCoordinator(options: CliRunOptions = {}): Promise<CliResult> {
  if (getTransport(options.env) === 'server') {
    return runToolViaServer('llm', options);
  }
  return runToolViaCli('llm', options);
}

export function runVectorCoordinator(options: CliRunOptions = {}): Promise<CliResult> {
  if (getTransport(options.env) === 'server') {
    return runToolViaServer('vector', options);
  }
  return runToolViaCli('vector', options);
}

export function runEmbeddingCoordinator(options: CliRunOptions = {}): Promise<CliResult> {
  if (getTransport(options.env) === 'server') {
    return runToolViaServer('embedding', options);
  }
  return runToolViaCli('embedding', options);
}
