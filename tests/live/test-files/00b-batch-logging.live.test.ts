// 00b — Batch logging: verify llm-batch-<id>.log and header redaction
import fs from 'fs';
import path from 'path';
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { testRuns } from '../config.ts';
import { withLiveEnv, redactionFoundIn, mergeSettings } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '00b-batch-logging';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? test : test.skip)(`00b-batch-logging — ${runCfg.name}`, async () => {
    const env = withLiveEnv({ TEST_FILE, LLM_ADAPTER_BATCH_ID: 'testbatch123', LLM_ADAPTER_BATCH_DIR: '0', LLM_ADAPTER_DISABLE_FILE_LOGS: '0' });
    const spec = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply exactly with: OK' }] }],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { temperature: 0, maxTokens: 200 }),
      functionToolNames: []
    };
    const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath, '--batch-id', 'testbatch123'], cwd: process.cwd(), env });
    expect(result.code).toBe(0);
    const batchFile = path.join(process.cwd(), 'logs', 'llm', 'llm-batch-testbatch123.log');
    expect(fs.existsSync(batchFile)).toBe(true);
    const content = fs.readFileSync(batchFile, 'utf-8');
    expect(redactionFoundIn(content)).toBe(true);
  }, 120000);
}

