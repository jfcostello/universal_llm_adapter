const Module = require('module');
const path = require('path');
const fs = require('fs');

function findPackageRoot(startDir) {
  let dir = startDir;
  // Walk up to find the nearest package.json
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

module.exports = (request, options) => {
  const requireFromBase = Module.createRequire(path.join(options.basedir, '__jest_resolver__.js'));

  try {
    // Jest's resolver uses `require.resolve`, which follows the `require` condition in package.json exports.
    // Our package exports are ESM-only (`import` condition). Map package self-references used in tests to the
    // built dist output so we can validate the published surface without adding CommonJS export conditions.
    if (request === 'llm-adapter' || request.startsWith('llm-adapter/')) {
      const rootDir = findPackageRoot(options.basedir);
      const subpath = request === 'llm-adapter' ? '' : request.slice('llm-adapter/'.length);
      if (!subpath) {
        return path.join(rootDir, 'dist', 'index.js');
      }

      // Handle first-level subpath exports.
      const mapping = {
        llm: path.join('dist', 'modules', 'llm', 'index.js'),
        realtime: path.join('dist', 'modules', 'realtime', 'index.js'),
        audio: path.join('dist', 'modules', 'audio', 'index.js'),
        server: path.join('dist', 'modules', 'server', 'index.js'),
        logging: path.join('dist', 'modules', 'logging', 'index.js'),
        mcp: path.join('dist', 'modules', 'mcp', 'index.js'),
        vector: path.join('dist', 'modules', 'vector', 'index.js'),
        embeddings: path.join('dist', 'modules', 'embeddings', 'index.js'),
        tools: path.join('dist', 'modules', 'tools', 'index.js'),
        cli: path.join('dist', 'modules', 'cli', 'index.js')
      };

      const rootSubpath = subpath.split('/')[0];
      if (mapping[rootSubpath]) {
        const resolved = path.join(rootDir, mapping[rootSubpath]);
        if (fs.existsSync(resolved)) {
          return resolved;
        }
      }
    }

    return requireFromBase.resolve(request);
  } catch (error) {
    if ((request.startsWith('./') || request.startsWith('../')) && request.endsWith('.js')) {
      const candidateTs = path.resolve(options.basedir, request.replace(/\.js$/, '.ts'));
      if (fs.existsSync(candidateTs) && fs.statSync(candidateTs).isFile()) {
        return candidateTs;
      }
    }
    throw error;
  }
};
