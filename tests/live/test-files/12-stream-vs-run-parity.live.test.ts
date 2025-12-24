// 12 — Stream vs Run Parity
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, parseStream, findDone, mergeSettings } from '@tests/helpers/live-v2.ts';
import { attachLangfuseObservability, createTraceId, waitForLangfuseTrace, stringifyLangfuseTrace } from '@tests/helpers/langfuse.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '12-stream-vs-run-parity';

function normalize(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? test : test.skip)(`12-stream-vs-run-parity — ${runCfg.name}`, async () => {
    const traceIdRun = createTraceId(`12-stream-vs-run-parity-${runCfg.name}-run`);
    const traceIdStream = createTraceId(`12-stream-vs-run-parity-${runCfg.name}-stream`);

    const baseSpec = makeSpec({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Answer questions concisely.' }]},
        { role: 'user', content: [{ type: 'text', text: 'What is 5 + 7? If you show the result, reply concisely.' }]}
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { temperature: 0, maxTokens: 1000 })
    });
    const runRes = await runCoordinator({
      args: ['run', '--spec', JSON.stringify(attachLangfuseObservability(baseSpec as any, traceIdRun)), '--plugins', pluginsPath],
      cwd: process.cwd(),
      env: withLiveEnv({ TEST_FILE })
    });
    expect(runRes.code).toBe(0);
    const runPayload = JSON.parse(runRes.stdout.trim());
    const streamRes = await runCoordinator({
      args: ['stream', '--spec', JSON.stringify(attachLangfuseObservability(baseSpec as any, traceIdStream)), '--plugins', pluginsPath],
      cwd: process.cwd(),
      env: withLiveEnv({ TEST_FILE })
    });
    expect(streamRes.code).toBe(0);
    const events = parseStream(streamRes.stdout);
    const done = findDone(events);
    const streamPayload = done?.response;
    const runText = normalize(String(runPayload.content?.[0]?.text ?? ''));
    const streamText = normalize(String(streamPayload?.content?.[0]?.text ?? ''));
    // Stream and run may produce slightly different text formatting
    // but both should contain the correct answer
    expect(runText).toContain('12');
    expect(streamText).toContain('12');
    const runCalls = JSON.stringify(runPayload.toolCalls || []);
    const streamCalls = JSON.stringify(streamPayload?.toolCalls || []);
    expect(runCalls).toBe(streamCalls);

    const traceRun = await waitForLangfuseTrace(traceIdRun, { timeoutMs: 60000, testFileBase: TEST_FILE });
    const traceRunText = stringifyLangfuseTrace(traceRun);
    expect(traceRunText).toContain('5 + 7');
    expect(traceRunText).toContain('12');

    const traceStream = await waitForLangfuseTrace(traceIdStream, { timeoutMs: 60000, testFileBase: TEST_FILE });
    const traceStreamText = stringifyLangfuseTrace(traceStream);
    expect(traceStreamText).toContain('5 + 7');
    expect(traceStreamText).toContain('12');
  }, 120000);
}
