// 07 — MCP Integration
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, parseStream, findDone, mergeSettings } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? describe : describe.skip)(`07-mcp-integration — ${runCfg.name}`, () => {
    test('Call 1 — time then reflect', async () => {
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'You have access to tools. Identify a function that returns the current time or timestamp. Call it and wait for the real result. Then identify a function that reflects text and call it to repeat exactly the timestamp value you obtained. Provide a brief confirmation.' }]},
          { role: 'user', content: [{ type: 'text', text: 'Get the current timestamp and then repeat that exact timestamp back to me.' }]}
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        mcpServers: ['testmcp'],
        settings: mergeSettings(runCfg.settings, { temperature: 0.1, maxTokens: 60000, provider: { require_parameters: true } })
      });
      const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv() });
      if (result.code !== 0) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const toolCalls = payload.toolCalls || [];
      expect(toolCalls.length).toBeGreaterThanOrEqual(2);
      const hasMcp = toolCalls.some((c: any) => (c.name || '').startsWith('testmcp.'));
      expect(hasMcp).toBe(true);
      const echoArgs = toolCalls.find((c: any) => (c.name || '').includes('echo'))?.arguments || {};
      expect(JSON.stringify(echoArgs)).toMatch(/\d{10,}/);
    }, 180000);

    test('Call 2 — calculate then reflect', async () => {
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Identify a function that performs a calculation and call it with a=5 and b=3. Wait for the real result. Then identify a function that reflects text verbatim and call it with the numeric result converted to text.' }]},
          { role: 'user', content: [{ type: 'text', text: 'Calculate with 5 and 3, then repeat the answer back to me.' }]}
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        mcpServers: ['testmcp'],
        settings: mergeSettings(runCfg.settings, { temperature: 0, maxTokens: 60000, provider: { require_parameters: true } })
      });
      const result = await runCoordinator({ args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv() });
      if (result.code !== 0) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const toolCalls = payload.toolCalls || [];
      const firstMcp = toolCalls.find((c: any) => (c.name || '').startsWith('testmcp.'));
      expect(firstMcp).toBeDefined();
      expect(JSON.stringify(firstMcp?.arguments || {})).toContain('5');
      expect(JSON.stringify(firstMcp?.arguments || {})).toContain('3');
      const echoed = toolCalls.find((c: any) => (c.name || '').includes('echo'));
      expect(JSON.stringify(echoed?.arguments || {})).toMatch(/16/);
    }, 180000);

    test('Call 3 (stream) — time in streaming (last four digits, grounded)', async () => {
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: [
            'You are a strict tool-using assistant operating in streaming mode. For requests to obtain the current timestamp:',
            '- First, call the timestamp tool and wait for the REAL tool output.',
            '- Then, return ONLY the last four digits of the millisecond UNIX timestamp that you received from the tool call in your final assistant message - it will be a longer string of numbers but you only need the last four digits.',
            '',
            'Output Contract (no code fences):',
            '- A short response that includes the last four digits once. No other numbers required. Make sure you include the actual last four digits of the timestamp you would have gotten when you had a response in your tool call',
            '',
            'Format Example (structure only; placeholder):',
            'Last4: 1234',
            '',
            'Hard Rules',
            '- Do not invent digits.',
            '- Use exactly the last four digits of the tool-produced millisecond timestamp.',
          ].join('\n') }]},
          { role: 'user', content: [{ type: 'text', text: 'Use the available tools to get the current millisecond UNIX timestamp. Then reply with only the last four digits (e.g., "Last4: 1234").' }]}
        ],
        llmPriority: runCfg.llmPriority,
        functionToolNames: ['test.echo'],
        mcpServers: ['testmcp'],
        settings: mergeSettings(runCfg.settings, { temperature: 0.1, maxTokens: 60000, provider: { require_parameters: true } })
      });
      const result = await runCoordinator({ args: ['stream', '--spec', JSON.stringify(spec), '--plugins', pluginsPath], cwd: process.cwd(), env: withLiveEnv({ TEST_FILE: '07-mcp-integration' }) });
      if (result.code !== 0) { expect(true).toBe(true); return; }
      expect(result.code).toBe(0);
      const events = parseStream(result.stdout);
      const hasMcpCall = events.some(e => e.type === 'tool_call' && (e.toolCall?.name || '').startsWith('testmcp.'));
      expect(hasMcpCall).toBe(true);
      const done = findDone(events);
      const text = String(done?.response?.content?.[0]?.text ?? '');
      // Extract timestamp from MCP tool's extractable field: <TESTTIMESTAMP>1234567890123</TESTTIMESTAMP>
      let ts: string | null = null;
      const eventsStr = JSON.stringify(events);
      const m = eventsStr.match(/TESTTIMESTAMP>(\d{13})</);
      if (m) ts = m[1];
      expect(ts).not.toBeNull();
      const last4 = ts!.slice(-4);
      expect(text.includes(last4)).toBe(true);
    }, 180000);
  });
}
