// 12 — Stream vs Run Parity
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, parseStream, findDone } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '12-stream-vs-run-parity';

function normalize(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? test : test.skip)(`12-stream-vs-run-parity — ${runCfg.name}`, async () => {
    const spec = makeSpec({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Answer questions concisely.' }]},
        { role: 'user', content: [{ type: 'text', text: 'What is 5 + 7? If you show the result, reply concisely.' }]}
      ],
      llmPriority: runCfg.llmPriority,
      settings: { ...runCfg.settings, temperature: 0, maxTokens: 200 }
    });
    const runRes = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
    expect(runRes.code).toBe(0);
    const runPayload = JSON.parse(runRes.stdout.trim());
    const streamRes = await runCoordinator({ args: ['stream', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE }) });
    expect(streamRes.code).toBe(0);
    const events = parseStream(streamRes.stdout);
    const done = findDone(events);
    const streamPayload = done?.response;
    const runText = normalize(String(runPayload.content?.[0]?.text ?? ''));
    const streamText = normalize(String(streamPayload?.content?.[0]?.text ?? ''));
    expect(runText).toBe(streamText);
    const runCalls = JSON.stringify(runPayload.toolCalls || []);
    const streamCalls = JSON.stringify(streamPayload?.toolCalls || []);
    expect(runCalls).toBe(streamCalls);
  }, 120000);
}

