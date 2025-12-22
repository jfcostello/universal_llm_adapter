import { spawnSync } from 'node:child_process';

function runNodeEsm(code: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--no-warnings', '-e', code], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function parseJsonLine(output: string): unknown {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error('No output received from node process');
  }
  return JSON.parse(lines[lines.length - 1]);
}

describe('root entrypoint lazy loading (dist)', () => {
  test('importing root does not load heavy optional deps', () => {
    const result = runNodeEsm(`
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      import { createRequire } from 'node:module';

      const require = createRequire(import.meta.url);
      const rootUrl = pathToFileURL(path.join(process.cwd(), 'dist/index.js')).href;

      await import(rootUrl);

      const cacheKeys = Object.keys(require.cache).map((p) => p.replace(/\\\\/g, '/'));
      const hits = cacheKeys.filter((p) =>
        p.includes('/node_modules/commander/') ||
        p.includes('/node_modules/winston/') ||
        p.includes('/node_modules/ws/')
      );

      console.log(JSON.stringify(hits));
    `);

    expect(result.status).toBe(0);
    const hits = parseJsonLine(result.stdout) as unknown;
    expect(hits).toEqual([]);
  });

  test('invoking --help loads commander but not logging/ws deps', () => {
    const result = runNodeEsm(`
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      import { createRequire } from 'node:module';

      const require = createRequire(import.meta.url);
      const rootUrl = pathToFileURL(path.join(process.cwd(), 'dist/index.js')).href;

      const root = await import(rootUrl);

      // Commander calls process.exit for --help. Turn that into a throw so we can keep
      // executing and inspect require.cache after the CLI module loads.
      const originalExit = process.exit;
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      const originalStderrWrite = process.stderr.write.bind(process.stderr);

      process.exit = (code) => {
        throw new Error('process.exit:' + String(code));
      };
      process.stdout.write = () => true;
      process.stderr.write = () => true;

      try {
        await root.runUnifiedCli(['node', 'llm-adapter', '--help']);
      } catch {
        // expected
      } finally {
        process.exit = originalExit;
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
      }

      const cacheKeys = Object.keys(require.cache).map((p) => p.replace(/\\\\/g, '/'));
      const hasCommander = cacheKeys.some((p) => p.includes('/node_modules/commander/'));
      const hasWinston = cacheKeys.some((p) => p.includes('/node_modules/winston/'));
      const hasWs = cacheKeys.some((p) => p.includes('/node_modules/ws/'));

      console.log(JSON.stringify({ hasCommander, hasWinston, hasWs }));
    `);

    expect(result.status).toBe(0);
    const flags = parseJsonLine(result.stdout) as any;
    expect(flags).toEqual({ hasCommander: true, hasWinston: false, hasWs: false });
  });
});
