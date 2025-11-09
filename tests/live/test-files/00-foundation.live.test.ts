// 00 — Foundation: exact phrase + fallback; deterministic math; header redaction
import fs from 'fs';
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { testRuns, invalidPriorityEntry } from '../config.ts';
import { withLiveEnv, buildLogPathFor, redactionFoundIn, makeSpec } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];

  (runLive ? describe : describe.skip)(`00-foundation — ${runCfg.name}`, () => {
    async function waitForFile(p: string, timeoutMs = 8000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (fs.existsSync(p)) return;
        await new Promise(res => setTimeout(res, 100));
      }
      throw new Error(`Timed out waiting for log file: ${p}`);
    }

    test('Call 1: exact phrase, fallback, extras log, header redaction', async () => {
      const testFileBase = '00-foundation';
      const env = withLiveEnv({ TEST_FILE: testFileBase });

      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: `You are a precise test assistant.\n\nCRITICAL INSTRUCTIONS — FOLLOW EXACTLY:\n1) When asked to reply with an exact phrase, reply with exactly that phrase and nothing else.\n2) Do not add explanations, prefixes, suffixes, or punctuation.\n3) If the phrase contains uppercase letters, preserve them exactly.` }]},
          { role: 'user', content: [{ type: 'text', text: 'Reply exactly with: INTEGRATION_TEST_OK' }]}
        ],
        llmPriority: [invalidPriorityEntry as any, ...runCfg.llmPriority],
        settings: { ...runCfg.settings, temperature: 0, maxTokens: 60000, fakeField: 'fakeValue' },
        functionToolNames: []
      });

      const result = await runCoordinator({
        args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const text = payload.content?.[0]?.text || '';
      expect(text.includes('INTEGRATION_TEST_OK')).toBe(true);
      expect(payload.provider).toBe(runCfg.llmPriority[0].provider);
      const extrasLogFound = result.logs.some(line => line.includes('Extra field not supported by provider') && line.includes('fakeField'));
      expect(extrasLogFound).toBe(true);
      const logPath = buildLogPathFor(testFileBase);
      await waitForFile(logPath, 8000);
      const logText = fs.readFileSync(logPath, 'utf-8');
      // SDK-based providers (URL starts with "SDK:") don't have HTTP headers to redact
      const isSDKBased = /Method:\s*SDK_CALL/.test(logText);
      if (!isSDKBased) {
        expect(redactionFoundIn(logText)).toBe(true);
      }
    }, 120000);

    test('Call 2: deterministic math', async () => {
      const env = withLiveEnv({ TEST_FILE: '00-foundation' });
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Respond concisely. When a user asks a math question and says "reply with only the number", reply with only the number and no words.' }]},
          { role: 'user', content: [{ type: 'text', text: 'What is 2 + 2? Reply with only the number.' }]}
        ],
        llmPriority: runCfg.llmPriority,
        settings: { ...runCfg.settings, temperature: 0, maxTokens: 60000 },
        functionToolNames: []
      });

      const result = await runCoordinator({
        args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const text = String(payload.content?.[0]?.text ?? '').trim();
      expect(text).toBe('4');
    }, 120000);
  });
}

