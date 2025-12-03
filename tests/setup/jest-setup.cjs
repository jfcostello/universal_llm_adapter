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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-ts-tests-'));
global.__LLM_ADAPTER_TS_TMP_ROOT__ = tmpRoot;

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (error) {
    // ignore cleanup errors
  }
});
