#!/usr/bin/env node

/**
 * MCP server fixture that intentionally crashes on tools/call to simulate host/process failures.
 */

import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function respond(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(response + '\n');
}

rl.on('line', (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: '1.0',
      serverInfo: { name: 'crash-mcp-server', version: '1.0.0' },
      capabilities: { tools: {} }
    });
    return;
  }

  if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [
        {
          name: 'crash',
          description: 'Crash the MCP host (for testing structured host failure handling)',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
          }
        }
      ]
    });
    return;
  }

  if (message.method === 'tools/call') {
    // Simulate an abrupt host/process failure.
    process.exit(1);
  }

  // Default: respond with empty result (should not be used).
  respond(message.id, {});
});

