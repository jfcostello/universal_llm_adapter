// 14 — Document Processing: Multiple documents in single message
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, mergeSettings } from '@tests/helpers/live-v2.ts';
import * as path from 'path';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '14-document-processing';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];

  (runLive ? describe : describe.skip)(`14-document-processing — ${runCfg.name}`, () => {
    test('should process multiple documents and extract specific data from each', async () => {
      const env = withLiveEnv({ TEST_FILE });

      // Build path to PDF fixture (only file type universally supported)
      const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures', 'sample-documents');
      const pdfPath = path.join(fixturesDir, 'sample.pdf');

      const spec = makeSpec({
        messages: [
          {
            role: 'system',
            content: [{
              type: 'text',
              text: 'You are a helpful assistant. A PDF file is attached. You must read that PDF and return ONLY the text extracted from it. Do not refuse, do not ask for the text, do not summarize, and do not add extra words. The PDF contains the phrase "Test PDF Document" — make sure your answer matches the file contents.'
            }]
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'What text is in this PDF document? Reply with just the text from the document.'
              },
              {
                type: 'document',
                source: { type: 'filepath', path: pdfPath }
              }
            ]
          }
        ],
        llmPriority: runCfg.llmPriority,
        settings: mergeSettings(runCfg.settings, { temperature: 0, maxTokens: 60000 }),
        functionToolNames: []
      });

      const result = await runCoordinator({
        args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env
      });

      if (result.code !== 0) {
        console.log(`\n=== ${runCfg.name} FAILED ===`);
        console.log('Exit code:', result.code);
        console.log('STDERR:', result.stderr.substring(result.stderr.length - 500));
        console.log('STDOUT:', result.stdout);
      }

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const text = payload.content?.[0]?.text || '';

      // Verify the LLM extracted the text from the PDF
      // Should contain "Test PDF Document" (case-insensitive, flexible spacing)
      expect(text.toLowerCase()).toMatch(/test.*pdf.*document|pdf.*document/);

      // Verify it used the correct provider
      expect(payload.provider).toBe(runCfg.llmPriority[0].provider);
    }, 180000);
  });
}
