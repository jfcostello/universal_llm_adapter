import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Extract provider/transport information from CLI args/env.
 *
 * NOTE: Live suite concurrency is controlled ONLY by `tests/live/config.ts`.
 * Any attempt to override worker concurrency via env/CLI is a hard failure.
 */
export function parseLaunchConfig(argv, env, defaults) {
  const args = [...argv];
  let provider = null;
  let transportFromCli = null;
  const passthrough = [];

  function hardFailOnForbiddenConcurrencyOverride(flag) {
    throw new Error(
      `Live tests must not set ${flag}. ` +
        'Do not cap concurrency to hide race conditions. ' +
        'Edit tests/live/config.ts (maxWorkersDefault) instead.'
    );
  }

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

    if (token === '--maxWorkers' || token.startsWith('--maxWorkers=')) hardFailOnForbiddenConcurrencyOverride('--maxWorkers');
    if (token === '-w' || token.startsWith('-w=')) hardFailOnForbiddenConcurrencyOverride('-w');
    if (token === '--runInBand' || token.startsWith('--runInBand=')) hardFailOnForbiddenConcurrencyOverride('--runInBand');
    if (token === '-i' || token.startsWith('-i=')) hardFailOnForbiddenConcurrencyOverride('-i');

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

  const envMax = String(env?.MAX_WORKERS ?? '').trim();
  if (envMax) {
    throw new Error(
      'Live tests must not set MAX_WORKERS. Edit tests/live/config.ts (maxWorkersDefault) instead.'
    );
  }

  const envTransport = env?.LLM_LIVE_TRANSPORT ? String(env.LLM_LIVE_TRANSPORT) : null;
  const transport = sanitizeTransport(transportFromCli ?? envTransport ?? 'cli');

  const forbiddenPassthrough = (passthrough || []).find((arg, idx, all) => {
    const t = String(arg);
    const next = String(all[idx + 1] ?? '');
    if (t === '--maxWorkers' || t.startsWith('--maxWorkers=')) return true;
    if (t === '-w' || t.startsWith('-w=')) return true;
    // handle "-w 2" (value is in the next token)
    if (next && t === '-w') return true;
    if (t === '--runInBand' || t.startsWith('--runInBand=')) return true;
    if (t === '-i' || t.startsWith('-i=')) return true;
    return false;
  });
  if (forbiddenPassthrough) hardFailOnForbiddenConcurrencyOverride(String(forbiddenPassthrough));

  const fallback = defaults?.maxWorkersDefault ?? 1;
  const maxWorkers = sanitizeMaxWorkers(fallback);

  return { provider, maxWorkers, transport, passthrough };
}

function sanitizeMaxWorkers(value) {
  if (typeof value === 'string') {
    const v = String(value).trim();
    if (/^\d+%$/.test(v)) return v;
    const parsed = Number.parseInt(v, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return '1';
    return String(Math.floor(parsed));
  }
  if (!Number.isFinite(value) || value < 1) return '1';
  return String(Math.floor(value));
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
    // Default to the live suite directory.
    args.push('--testPathPattern=tests[\\\\/]live[\\\\/]test-files');
  }

  // Increase per-test timeout for live suites (default jest config is 120s)
  args.push(
    `--maxWorkers=${maxWorkers}`,
    '--coverage=false',
    '--testTimeout=300000'
  );

  if (Array.isArray(passthrough) && passthrough.length) {
    args.push(...passthrough);
  }

  return { nodeArgs: ['--experimental-vm-modules'], jestArgs: args, rootDir };
}
