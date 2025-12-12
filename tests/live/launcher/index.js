import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Extract maxWorkers and provider information from CLI args and env.
 * Precedence: CLI flag > MAX_WORKERS env > config default.
 */
export function parseLaunchConfig(argv, env, defaults) {
  const args = [...argv];
  let provider = null;
  let maxWorkersFromCli = null;
  let transportFromCli = null;
  const passthrough = [];

  // First non-flag token is treated as provider selector
  while (args.length) {
    const token = args.shift();
    if (token === '--') {
      // push the rest to passthrough and stop parsing
      passthrough.push(...args);
      break;
    }

    if (!token.startsWith('-') && provider === null) {
      provider = token;
      continue;
    }

    if (token === '--maxWorkers') {
      const next = args.shift();
      if (next) {
        maxWorkersFromCli = parseInt(next, 10);
        continue;
      }
    } else if (token.startsWith('--maxWorkers=')) {
      const val = token.split('=')[1];
      maxWorkersFromCli = parseInt(val, 10);
      continue;
    }

    if (token === '--transport') {
      const next = args.shift();
      if (next) {
        transportFromCli = String(next);
        continue;
      }
    } else if (token.startsWith('--transport=')) {
      const val = token.split('=')[1];
      transportFromCli = String(val);
      continue;
    }

    passthrough.push(token);
  }

  const envMax = env?.MAX_WORKERS ? parseInt(env.MAX_WORKERS, 10) : null;
  const fallback = defaults?.maxWorkersDefault ?? 1;
  const maxWorkers = sanitizeMaxWorkers(maxWorkersFromCli ?? envMax ?? fallback);

  const envTransport = env?.LLM_LIVE_TRANSPORT ? String(env.LLM_LIVE_TRANSPORT) : null;
  const transport = sanitizeTransport(transportFromCli ?? envTransport ?? 'cli');

  return { provider, maxWorkers, transport, passthrough };
}

function sanitizeMaxWorkers(value) {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function sanitizeTransport(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'server' || v === 'both') return v;
  return 'cli';
}

/**
 * Build the Jest command/args for live tests.
 */
export function buildJestArgs({ maxWorkers, passthrough }) {
  const rootDir = path.resolve(__dirname, '../../..');
  const jestBin = path.join(rootDir, 'node_modules', 'jest', 'bin', 'jest.js');

  const hasCustomPattern = (passthrough || []).some(arg => arg.startsWith('--testPathPattern'));

  const args = [jestBin];
  if (!hasCustomPattern) {
    args.push('--testPathPattern=live');
  }

  // Increase per-test timeout for live suites (default jest config is 120s)
  args.push(
    `--maxWorkers=${maxWorkers}`,
    '--forceExit',
    '--coverage=false',
    '--testTimeout=300000'
  );

  if (Array.isArray(passthrough) && passthrough.length) {
    args.push(...passthrough);
  }

  return { nodeArgs: ['--experimental-vm-modules'], jestArgs: args, rootDir };
}
