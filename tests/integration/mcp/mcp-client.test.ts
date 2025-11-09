import path from 'path';
import { MCPConnection, MCPClientPool } from '@/mcp/mcp-client.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

const config = {
  id: 'local',
  command: 'node',
  args: ['./tests/fixtures/mcp/server.mjs'],
  env: {},
  autoStart: true
} as any;

describe('mcp/mcp-client integration', () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    process.chdir(ROOT_DIR);
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  test('lists tools with prefixes and calls tool', async () => {
    const connection = new MCPConnection(config);
    await connection.connect();

    const tools = await connection.listTools();
    expect(tools.map(t => t.name)).toContain('local.ping');

    const result = await connection.callTool('local.ping', { payload: 'test' });
    expect(result.result).toBe('pong');

    await connection.close();
  });

  test('pool reuses connections and closes cleanly', async () => {
    const pool = new MCPClientPool([config]);

    const tools = await pool.listTools('local');
    expect(tools).toHaveLength(4);

    const echo = await pool.call('local', 'local.echo', { text: 'hello' });
    expect(echo.result).toBe('hello');

    await pool.close();
  });
});
