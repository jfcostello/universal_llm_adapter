import baseConfig from './jest.config.js';

export default {
  ...baseConfig,
  // Live tests are run via `npm run test:live*` (with required env checks).
  // Keep `npm test` strictly unit/integration with no skipped live suites.
  testPathIgnorePatterns: [
    ...(baseConfig.testPathIgnorePatterns ?? []),
    '<rootDir>/tests/live/'
  ]
};

