#!/usr/bin/env node

/**
 * Test MCP server for live integration tests.
 * Implements a JSON-RPC 2.0 server over stdio with multiple test tools:
 * - test_ping: Test connectivity and server response
 * - test_echo: Echo messages back
 * - test_calculate: Add two numbers
 * - test_reverse: Reverse a string
 * - test_timestamp: Get current timestamp
 */

import readline from 'readline';

const tools = [
  {
    name: 'test_ping',
    description: 'Test connectivity and verify the server is responding',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Optional message to include in response'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'test_echo',
    description: 'Echo or reflect a message back exactly as provided',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to echo back'
        }
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'test_calculate',
    description: 'Perform a calculation on numbers (adds 8 to result)',
    inputSchema: {
      type: 'object',
      properties: {
        a: {
          type: 'number',
          description: 'First number'
        },
        b: {
          type: 'number',
          description: 'Second number (optional)'
        }
      },
      required: ['a'],
      additionalProperties: false
    }
  },
  {
    name: 'test_reverse',
    description: 'Reverse a string by flipping the order of its characters',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to reverse'
        }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'test_timestamp',
    description: 'Get the current timestamp in milliseconds',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function respond(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(response + '\n');
}

function respondError(id, code, message) {
  const response = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message }
  });
  process.stdout.write(response + '\n');
}

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const message = JSON.parse(line);

    // Handle initialize
    if (message.method === 'initialize') {
      respond(message.id, {
        protocolVersion: '1.0',
        serverInfo: {
          name: 'test-mcp-server',
          version: '1.0.0'
        },
        capabilities: {
          tools: {}
        }
      });
      return;
    }

    // Handle tools/list
    if (message.method === 'tools/list') {
      respond(message.id, {
        tools: tools
      });
      return;
    }

    // Handle tools/call
    if (message.method === 'tools/call') {
      const toolName = message.params?.name;
      const args = message.params?.arguments || {};

      if (toolName === 'test_ping') {
        const customMessage = args.message;
        const ts = Date.now();
        respond(message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                result: 'pong',
                timestamp: ts,
                message: customMessage || 'ping received',
                extractable: `<PINGTIMESTAMP>${ts}</PINGTIMESTAMP>`
              })
            }
          ]
        });
        return;
      }

      if (toolName === 'test_echo') {
        respond(message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                echo: args.message || ''
              })
            }
          ]
        });
        return;
      }

      if (toolName === 'test_calculate') {
        const a = args.a || 0;
        const b = args.b || 0;
        const result = a + b + 8;
        const resultObj = {
          result: result,
          a: a,
          extractable: `<CALCRESULT>${result}</CALCRESULT>`
        };
        if (args.b !== undefined) {
          resultObj.b = b;
        }
        respond(message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(resultObj)
            }
          ]
        });
        return;
      }

      if (toolName === 'test_reverse') {
        const original = args.text || '';
        const reversed = original.split('').reverse().join('');
        const length = original.length;
        const formattedResult = `[R:${length}]${reversed}`;
        respond(message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                original: original,
                reversed: formattedResult
              })
            }
          ]
        });
        return;
      }

      if (toolName === 'test_timestamp') {
        const ts = Date.now();
        respond(message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                timestamp: ts,
                iso: new Date().toISOString(),
                extractable: `<TESTTIMESTAMP>${ts}</TESTTIMESTAMP>`
              })
            }
          ]
        });
        return;
      }

      respondError(message.id, -32601, `Unknown tool: ${toolName}`);
      return;
    }

    // Unknown method
    respondError(message.id, -32601, `Unknown method: ${message.method}`);
  } catch (error) {
    respondError(0, -32700, `Parse error: ${error.message}`);
  }
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});
