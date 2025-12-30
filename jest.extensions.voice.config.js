import baseConfig from './jest.extensions.config.js';

export default {
  ...baseConfig,
  detectOpenHandles: true,
  testMatch: [
    '<rootDir>/extensions/voice/tests/**/*.test.ts',
    '<rootDir>/plugins/voice-*/**/tests/**/*.test.ts'
  ],
  collectCoverageFrom: [
    '<rootDir>/extensions/voice/**/*.ts',
    '<rootDir>/plugins/voice-*/**/*.ts',
    '!<rootDir>/dist/**',
    '!<rootDir>/node_modules/**',
    '!<rootDir>/**/tests/**',
    '!<rootDir>/**/__tests__/**',
    '!<rootDir>/examples/**',
    '!<rootDir>/**/.history/**'
  ],
  coverageDirectory: '<rootDir>/coverage/extensions/voice'
};
