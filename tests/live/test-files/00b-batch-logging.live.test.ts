// 00b — Batch logging: verify llm-batch-<id>.log and header redaction
import fs from 'fs';
import path from 'path';
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns } from '../config.ts';
import { withLiveEnv, redactionFoundIn, mergeSettings } from '@tests/helpers/live-v2.ts';
import { attachLangfuseObservability, createTraceId, waitForLangfuseTrace, stringifyLangfuseTrace } from '@tests/helpers/langfuse.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '00b-batch-logging';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? test : test.skip)(`00b-batch-logging — ${runCfg.name}`, async () => {
    const batchId = process.env.LLM_LIVE_BATCH_ID || 'testbatch123';
    const traceId = createTraceId(`${TEST_FILE}-${runCfg.name}`);
    const env = withLiveEnv({ TEST_FILE, LLM_ADAPTER_BATCH_ID: batchId, LLM_ADAPTER_BATCH_DIR: '0', LLM_ADAPTER_DISABLE_FILE_LOGS: '0' });
    const spec = attachLangfuseObservability({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply exactly with: OK' }] }],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { temperature: 0, maxTokens: 200, batchId }),
      functionToolNames: []
    } as any, traceId);
    const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath, '--batch-id', batchId], cwd: process.cwd(), env });
    expect(result.code).toBe(0);
    const batchFile = path.join(process.cwd(), 'logs', 'llm', `llm-batch-${batchId}.log`);
    expect(fs.existsSync(batchFile)).toBe(true);
    const content = fs.readFileSync(batchFile, 'utf-8');
    expect(redactionFoundIn(content)).toBe(true);

    const trace = await waitForLangfuseTrace(traceId, { timeoutMs: 60000 });
    const sessionId = (trace as any)?.sessionId;
    if (sessionId !== undefined && sessionId !== null && String(sessionId).trim() !== '') {
      expect(String(sessionId)).toBe(String(batchId));
    } else {
      expect(stringifyLangfuseTrace(trace)).toContain(`\"sessionId\":\"${batchId}\"`);
    }
  }, 120000);
}
