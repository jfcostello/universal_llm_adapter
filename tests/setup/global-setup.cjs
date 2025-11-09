const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async () => {
  const rootDir = path.resolve(__dirname, '../..');
  const tsc = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');

  const result = spawnSync('node', [tsc, '--project', path.join(rootDir, 'tsconfig.json')], {
    cwd: rootDir,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    throw new Error('TypeScript build failed during Jest global setup');
  }
};
