#!/usr/bin/env tsx
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseLaunchConfig, buildJestArgs } from './launcher/index.js';
import { maxWorkersDefault } from './config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');

async function main() {
  const { provider, maxWorkers, passthrough } = parseLaunchConfig(
    process.argv.slice(2),
    process.env,
    { maxWorkersDefault }
  );

  const { nodeArgs, jestArgs } = buildJestArgs({ maxWorkers, passthrough });

  const env = { ...process.env, LLM_LIVE: '1' };
  if (provider) {
    env.LLM_TEST_PROVIDERS = provider;
  }

  const child = spawn(process.execPath, [...nodeArgs, ...jestArgs], {
    cwd: rootDir,
    env,
    stdio: 'inherit'
  });

  child.on('close', code => {
    process.exitCode = code;
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
