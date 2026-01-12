import baseConfig from './jest.config.js';

export default {
  ...baseConfig,
  setupFiles: [
    ...(baseConfig.setupFiles ?? []),
    '<rootDir>/tests/setup/extensions-env.cjs'
  ],
  testMatch: [
    '<rootDir>/extensions/**/tests/**/*.test.ts',
    '<rootDir>/extensions/**/plugins/**/tests/**/*.test.ts'
  ],
  testPathIgnorePatterns: [
    ...(baseConfig.testPathIgnorePatterns ?? []),
    '<rootDir>/tests/',
    '<rootDir>/tests/live/'
  ],
  collectCoverageFrom: [
    '<rootDir>/extensions/**/*.ts',
    '!<rootDir>/dist/**',
    '!<rootDir>/node_modules/**',
    '!<rootDir>/**/tests/**',
    '!<rootDir>/**/__tests__/**',
    '!<rootDir>/examples/**',
    '!<rootDir>/**/.history/**'
  ],
  coverageDirectory: '<rootDir>/coverage/extensions'
};
