const Module = require('module');
const path = require('path');
const fs = require('fs');

module.exports = (request, options) => {
  const requireFromBase = Module.createRequire(path.join(options.basedir, '__jest_resolver__.js'));

  try {
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
