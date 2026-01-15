const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

// Load .env file from project root so API keys are available in process.env
// This is needed because tests spawn child processes that inherit process.env
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// API keys should come from .env file - no test defaults
process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
beforeEach(() => {
  // Prevent test-order leakage: tests that validate file logging must explicitly opt-in.
  process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
});

// Silence expected warnings in test output.
// These are dev-only warnings that fire when test fixtures use cwd-relative paths
// instead of manifest-relative paths. The behavior is tested explicitly in
// tool-coordinator.success.test.ts; everywhere else it's just noise.
const originalWarn = console.warn;
console.warn = function (...args) {
  if (args[0] === 'process_route.invoke_module.cwd_fallback') return;
  return originalWarn.apply(console, args);
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ts-tests-'));
global.__LLM_ADAPTER_TS_TMP_ROOT__ = tmpRoot;

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (error) {
    // ignore cleanup errors
  }
});
