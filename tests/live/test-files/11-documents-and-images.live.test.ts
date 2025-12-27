import { buildLogPathFor, mergeSettings, parseLogBodies, runLlmOnce } from '@tests/helpers/live.ts';
import { getTmpRoot } from '@tests/helpers/paths.ts';
import type { LLMResponse, Message } from '@tests/helpers/live-types.ts';
import { filteredTestRuns } from '../config.ts';
import fs from 'fs';
import path from 'path';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '11-documents-and-images';

function lastNonEmptyLine(text: string): string {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function parseJsonLine(text: string): any {
  return JSON.parse(lastNonEmptyLine(text));
}

function extractAssistantText(response: LLMResponse): string {
  const content = Array.isArray(response?.content) ? response.content : [];
  return content
    .filter(p => p && typeof p === 'object' && (p as any).type === 'text')
    .map(p => String((p as any).text ?? ''))
    .join('');
}

type NormalizedLiveRequestBody = {
  __liveType?: string;
  messages?: any[];
};

function findNormalizedRequestBodies(bodies: any[]): NormalizedLiveRequestBody[] {
  return bodies
    .filter(b => b && typeof b === 'object' && b.__liveType === 'normalized_llm_request')
    .map(b => b as NormalizedLiveRequestBody);
}

function findFirstInlinedDocumentText(messages: any[]): string | null {
  for (const msg of messages) {
    const parts = Array.isArray(msg?.content) ? msg.content : [];
    for (const part of parts) {
      if (part?.type !== 'text') continue;
      const text = String(part?.text ?? '');
      if (text.startsWith('Document (') && text.includes('text/plain')) {
        return text;
      }
    }
  }
  return null;
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('Filepath document attachments are loaded + encoded, and the model can answer a doc-grounded question', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const token = `DOC_TOKEN_${Date.now()}`;
    const tmpRoot = getTmpRoot();
    const docPath = path.join(tmpRoot, `live-doc-${Date.now()}.txt`);
    fs.writeFileSync(
      docPath,
      [
        'Live document fixture for testing.',
        `TOKEN:${token}`,
        'End.'
      ].join('\n'),
      'utf-8'
    );

    const systemPrompt = [
      'You are a conformance test agent.',
      'Answer the user using the attached document content.',
      'When the user says "Reply with exactly X", you MUST output exactly X and nothing else.'
    ].join('\n');

    const prompt = [
      'From the attached document, find the line that starts with "TOKEN:".',
      'Reply with exactly the token value after "TOKEN:".',
      'Do not guess or invent values. The token is present only in the attached document.'
    ].join('\n');

    const spec = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'filepath', path: docPath } },
            { type: 'text', text: prompt }
          ]
        }
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { maxTokens: 256 })
    };

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'filepath-doc' });
    expect(call.result.code).toBe(0);
    expect(call.response).toBeTruthy();

    const response = call.response as LLMResponse;
    expect(extractAssistantText(response).trim()).toBe(token);

    const logPath = buildLogPathFor(TEST_FILE);
    const bodies = parseLogBodies(logPath);
    const normalized = findNormalizedRequestBodies(bodies);
    expect(normalized.length).toBeGreaterThan(0);

    const docBody = normalized.find(b =>
      Array.isArray(b?.messages) &&
      b.messages.some(m =>
        Array.isArray(m?.content) &&
        m.content.some((p: any) => p?.type === 'text' && String(p?.text || '').includes(`TOKEN:${token}`))
      )
    );
    expect(docBody).toBeTruthy();

    const inlined = findFirstInlinedDocumentText((docBody as any).messages);
    expect(inlined).toBeTruthy();
    expect(String(inlined)).toContain(path.basename(docPath));
    expect(String(inlined)).toContain(`TOKEN:${token}`);
  }, 180_000);

  test('Unsupported document mime types are rejected with a structured error', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const spec = {
      messages: [
        { role: 'user', content: [{ type: 'document', source: { type: 'base64', data: 'SGVsbG8=' }, mimeType: 'application/x-unknown', filename: 'x.bin' }] }
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { maxTokens: 16 })
    };

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'unsupported-mime' });
    expect(call.result.code).not.toBe(0);
    const body = parseJsonLine(call.result.stderr);
    expect(body?.type).toBe('error');
    expect(body?.error?.code).toBe('unsupported_mime_type');
  }, 60_000);
});
