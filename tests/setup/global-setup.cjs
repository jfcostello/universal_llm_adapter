const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async () => {
  if (process.env.LLM_SKIP_TS_BUILD === '1') {
    return;
  }

  const rootDir = path.resolve(__dirname, '../..');
  let tsc;
  try {
    tsc = require.resolve('typescript/bin/tsc');
  } catch {
    throw new Error('TypeScript is not installed (missing typescript/bin/tsc)');
  }

  const result = spawnSync('node', [tsc, '--project', path.join(rootDir, 'tsconfig.json')], {
    cwd: rootDir,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    throw new Error('TypeScript build failed during Jest global setup');
  }
};
