import baseConfig from './jest.config.js';

export default {
  ...baseConfig,
  testMatch: [
    '<rootDir>/extensions/**/tests/**/*.test.ts',
    '<rootDir>/plugins/voice-*/**/tests/**/*.test.ts'
  ],
  testPathIgnorePatterns: [
    ...(baseConfig.testPathIgnorePatterns ?? []),
    '<rootDir>/tests/',
    '<rootDir>/tests/live/'
  ],
  collectCoverageFrom: [
    '<rootDir>/extensions/**/*.ts',
    '<rootDir>/plugins/voice-*/**/*.ts',
    '!<rootDir>/dist/**',
    '!<rootDir>/node_modules/**',
    '!<rootDir>/**/tests/**',
    '!<rootDir>/**/__tests__/**',
    '!<rootDir>/examples/**',
    '!<rootDir>/**/.history/**'
  ],
  coverageDirectory: '<rootDir>/coverage/extensions'
};
