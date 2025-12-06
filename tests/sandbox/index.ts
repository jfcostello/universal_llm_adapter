#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { Command } from 'commander';
import { loadScenario, SandboxScenario } from './internal/load-scenario.js';
import type { ContentPart, LLMCallSpec, Message } from './internal/load-scenario.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DIST_CLI = path.join(ROOT_DIR, 'dist', 'llm_coordinator.js');
const SANDBOX_LOG_DIR = path.join(ROOT_DIR, 'tests', 'sandbox', 'logs');

async function main(): Promise<void> {
  const program = new Command();
  program
    .requiredOption('-s, --scenario <path>', 'Path to sandbox scenario YAML')
    .option('--dry-run', 'Load and validate scenario only, do not call CLI', false)
    .option('--interactive', 'After scripted turns, continue in interactive chat until exit', false);

  const { scenario, dryRun, interactive } = program.parse(process.argv).opts();

  const loaded = loadScenario(scenario);
  // CLI flag enables interactive; absence of flag leaves scenario setting intact
  if (interactive) {
    loaded.run.interactive = true;
  }

  if (dryRun) {
    console.log(JSON.stringify({ type: 'scenario.valid', name: loaded.run.name ?? path.basename(scenario) }, null, 2));
    return;
  }

  await ensureDistExists();
  await runScenario(loaded, scenario);
}

async function ensureDistExists(): Promise<void> {
  if (fs.existsSync(DIST_CLI)) return;
  throw new Error('dist/llm_coordinator.js not found. Run `npm run build` before running the sandbox.');
}

async function runScenario(scenario: SandboxScenario, scenarioPath: string): Promise<void> {
  const runName = scenario.run.name ?? createStamp();
  const turnMode = scenario.run.mode ?? 'run';
  const pluginsPath = path.resolve(ROOT_DIR, scenario.run.pluginsPath ?? './plugins');
  const env = {
    ...process.env,
    ...(scenario.env ?? {})
  };
  let stubServer: Awaited<ReturnType<typeof startStubServer>> | null = null;

  // Auto-spin a stub server when using fixture plugins and no endpoint provided
  if (!env.TEST_LLM_ENDPOINT && pluginsPath.includes('tests/fixtures/plugins/basic')) {
    stubServer = await startStubServer();
    env.TEST_LLM_ENDPOINT = stubServer.url;
  }
  if (scenario.run.batchId) {
    env.LLM_ADAPTER_BATCH_ID = String(scenario.run.batchId);
  }

  const runDir = path.join(SANDBOX_LOG_DIR, runName);
  fs.mkdirSync(runDir, { recursive: true });

  const transcriptPath = scenario.run.transcriptPath
    ? path.resolve(ROOT_DIR, scenario.run.transcriptPath)
    : path.join(runDir, 'transcript.txt');

  const transcript: string[] = [];
  const conversation: Message[] = [...scenario.initialMessages];

  console.log(`\n=== Sandbox Run: ${runName} ===`);
  console.log(`Scenario file: ${path.relative(ROOT_DIR, scenarioPath)}`);
  console.log(`Mode: ${turnMode}`);
  console.log(`Plugins: ${pluginsPath}`);
  console.log('');

  for (const [index, userMessage] of scenario.turns.entries()) {
    conversation.push(userMessage);
    transcript.push(headerLine(index + 1));
    transcript.push(`User: ${contentToPlain(userMessage.content)}`);
    printDivider(index + 1, 'user');

    const callSpec = buildCallSpec(scenario.baseSpec, conversation);
    const turnResult = await invokeCli(callSpec, {
      mode: turnMode,
      pluginsPath,
      env
    });

    const assistantText = contentToPlain(turnResult.assistant.content);
    transcript.push(`Assistant: ${assistantText}`);
    transcript.push('');

    console.log(assistantLabel(index + 1));
    console.log(assistantText || '[no text content]');
    console.log('');

    conversation.push(turnResult.assistant);
  }

  if (scenario.run.interactive) {
    await runInteractiveLoop({
      conversation,
      baseSpec: scenario.baseSpec,
      mode: turnMode,
      pluginsPath,
      env,
      transcript,
      runDir
    });
  }

  fs.writeFileSync(transcriptPath, transcript.join('\n'), 'utf-8');
  console.log(`Transcript saved to ${path.relative(ROOT_DIR, transcriptPath)}`);

  if (scenario.run.copyLogs ?? true) {
    await copyLogs(runDir);
  }

  console.log(`Run artifacts: ${path.relative(ROOT_DIR, runDir)}`);

  if (stubServer) {
    await stubServer.close();
  }
}

function buildCallSpec(baseSpec: Omit<LLMCallSpec, 'messages'>, messages: Message[]): LLMCallSpec {
  return {
    ...(baseSpec as LLMCallSpec),
    messages
  };
}

function invokeCli(
  spec: LLMCallSpec,
  options: {
    mode: 'run' | 'stream';
    pluginsPath: string;
    env: NodeJS.ProcessEnv;
    transcript?: string[];
  }
): Promise<{ assistant: Message; raw?: LLMResponse }> {
  return new Promise((resolve, reject) => {
    const args = [
      DIST_CLI,
      options.mode === 'stream' ? 'stream' : 'run',
      '--plugins',
      options.pluginsPath
    ];

    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let lastResponse: LLMResponse | null = null;
    let streamingText = '';

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        handleStdoutLine(trimmed);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    child.on('close', (code) => {
      if (stdoutBuf.trim()) {
        handleStdoutLine(stdoutBuf.trim());
      }

      if (code !== 0 && !lastResponse) {
        return reject(new Error(`CLI exited with code ${code}: ${stderrBuf || 'no stderr'}`));
      }

      const assistant = responseToAssistant(lastResponse, streamingText);
      if (!assistant) {
        return reject(new Error('No assistant response received from CLI'));
      }

      resolve({ assistant, raw: lastResponse ?? undefined });
    });

    child.stdin.write(JSON.stringify(spec));
    child.stdin.end();

    function handleStdoutLine(line: string): void {
      try {
        const parsed = JSON.parse(line);

        if (parsed.type === 'log') {
          console.log(`[log] ${parsed.level ?? ''} ${parsed.message ?? ''}`);
          return;
        }

        if (parsed.type === 'response' && parsed.data) {
          lastResponse = parsed.data as LLMResponse;
          return;
        }

        if (parsed.type === 'delta' || parsed.type === 'token') {
          if (typeof parsed.content === 'string') {
            streamingText += parsed.content;
            process.stdout.write(parsed.content);
            options.transcript?.push(`Assistant(stream): ${parsed.content}`);
          } else if (typeof parsed.text === 'string') {
            streamingText += parsed.text;
            process.stdout.write(parsed.text);
            options.transcript?.push(`Assistant(stream): ${parsed.text}`);
          }
          return;
        }

        if (parsed.type === 'done' && parsed.response) {
          lastResponse = parsed.response as LLMResponse;
          return;
        }

        // Fallback: print raw
        console.log(line);
      } catch {
        console.log(line);
      }
    }
  });
}

function responseToAssistant(response: any | null, fallbackText: string): Message | null {
  if (response) {
    return {
      role: 'assistant',
      content: response.content as ContentPart[],
      toolCalls: response.toolCalls
    };
  }

  if (fallbackText) {
    return {
      role: 'assistant',
      content: [{ type: 'text', text: fallbackText }]
    };
  }

  return null;
}

function contentToPlain(content: ContentPart[] | undefined): string {
  if (!content || content.length === 0) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      texts.push(part.text ?? '');
    } else if (part.type === 'image') {
      texts.push('[image]');
    } else if (part.type === 'document') {
      texts.push('[document]');
    } else if (part.type === 'tool_result') {
      texts.push(`[tool_result:${part.toolName}]`);
    }
  }
  return texts.join(' ');
}

function headerLine(turn: number): string {
  return `--- Turn ${turn} ---`;
}

function assistantLabel(turn: number): string {
  return `Assistant (turn ${turn}):`;
}

function printDivider(turn: number, who: 'user' | 'assistant'): void {
  const label = who === 'user' ? `User -> Turn ${turn}` : `Assistant -> Turn ${turn}`;
  console.log(label);
}

async function runInteractiveLoop(options: {
  conversation: Message[];
  baseSpec: Omit<LLMCallSpec, 'messages'>;
  mode: 'run' | 'stream';
  pluginsPath: string;
  env: NodeJS.ProcessEnv;
  transcript: string[];
  runDir: string;
}): Promise<void> {
  const rl = await import('readline');
  const readline = rl.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = () =>
    new Promise<string | null>((resolve) => {
      try {
        readline.question('You: ', answer => resolve(answer));
      } catch (err: any) {
        if (err?.code === 'ERR_USE_AFTER_CLOSE') {
          resolve(null);
        } else {
          throw err;
        }
      }
    });

  console.log('--- Interactive mode: type your message, or Ctrl+C to exit ---');

  let turn = options.conversation.filter(m => m.role === 'user').length + 1;

  while (true) {
    const userInput = await prompt();
    if (userInput === null) {
      break;
    }
    if (userInput.trim().toLowerCase() === 'exit') {
      break;
    }

    const userMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: userInput }]
    };

    options.conversation.push(userMessage);
    options.transcript.push(headerLine(turn));
    options.transcript.push(`User: ${userInput}`);
    printDivider(turn, 'user');

    const callSpec = buildCallSpec(options.baseSpec, options.conversation);
    const turnResult = await invokeCli(callSpec, {
      mode: options.mode,
      pluginsPath: options.pluginsPath,
      env: options.env,
      transcript: options.transcript
    });

    const assistantText = contentToPlain(turnResult.assistant.content);
    options.transcript.push(`Assistant: ${assistantText}`);
    options.transcript.push('');

    console.log(assistantLabel(turn));
    console.log(assistantText || '[no text content]');
    console.log('');

    options.conversation.push(turnResult.assistant);
    turn += 1;
  }

  readline.close();
}

async function copyLogs(destinationRoot: string): Promise<void> {
  const source = path.join(ROOT_DIR, 'logs');
  if (!fs.existsSync(source)) {
    console.log('No logs directory to copy.');
    return;
  }

  const target = path.join(destinationRoot, 'logs');
  await fs.promises.cp(source, target, { recursive: true, force: true });
  console.log(`Logs copied to ${path.relative(ROOT_DIR, target)}`);
}

function createStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

  void main();

async function startStubServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const http = await import('http');

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const isStream = payload.stream === true;
        if (isStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [
            {
              message: {
                content: [{ type: 'text', text: 'Hello from stub server!' }]
              },
              finish_reason: 'stop'
            }
          ]
        }));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          close: () =>
            new Promise<void>((res, rej) => {
              server.close(err => (err ? rej(err) : res()));
            })
        });
      } else {
        reject(new Error('Failed to start stub server'));
      }
    });
    server.on('error', reject);
  });
}
