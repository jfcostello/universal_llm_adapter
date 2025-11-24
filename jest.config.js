import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  rootDir: path.resolve(__dirname),
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/tests/live/_v1_legacy/'
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  extensionsToTreatAsEsm: ['.ts'],
  resolver: './tests/setup/ts-resolver.cjs',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1'
  },
  globals: {
    'ts-jest': {
      useESM: true,
      tsconfig: path.resolve(__dirname, 'tsconfig.json'),
      diagnostics: {
        ignoreCodes: [151002, 2307]
      }
    }
  },
  collectCoverage: true,
  collectCoverageFrom: [
    '<rootDir>/**/*.ts',
    '!<rootDir>/dist/**',
    '!<rootDir>/node_modules/**',
    '!<rootDir>/tests/**',
    '!<rootDir>/jest.config.js',
    '!<rootDir>/examples/**',
    '!<rootDir>/**/.history/**'
  ],
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    }
  },
  setupFilesAfterEnv: ['./tests/setup/jest-setup.cjs'],
  globalSetup: './tests/setup/global-setup.cjs',
  globalTeardown: './tests/setup/global-teardown.cjs',
  testTimeout: 120000,
  transformIgnorePatterns: []
};
