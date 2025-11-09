import readline from 'readline';

const tools = [
  {
    name: 'ping',
    description: 'Return pong',
    inputSchema: {
      type: 'object',
      properties: {
        payload: {
          type: 'string'
        }
      },
      required: ['payload']
    }
  },
  {
    name: 'echo',
    description: 'Echo text back',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'stream',
    description: 'Return streamed chunks',
    inputSchema: {
      type: 'object',
      properties: {
        chunks: {
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['chunks']
    }
  },
  {
    name: 'slow',
    description: 'Respond after a delay',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: { type: 'number' }
      }
    }
  }
];

const rl = readline.createInterface({ input: process.stdin });

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\n'
  );
}

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      // Validate MCP protocol requirements
      if (!message.params?.clientInfo) {
        respondError(message.id, 'Required field missing: clientInfo');
        return;
      }
      if (!message.params.clientInfo.name || !message.params.clientInfo.version) {
        respondError(message.id, 'clientInfo must contain name and version');
        return;
      }
      respond(message.id, {
        protocolVersion: message.params.protocolVersion || '2025-03-26',
        capabilities: message.params?.capabilities || {},
        serverInfo: {
          name: 'test-mcp-server',
          version: '1.0.0'
        }
      });
      return;
    }

    if (message.method === 'tools/list') {
      const cursor = message.params?.cursor ?? 0;
      const pageSize = 1;
      const start = Number(cursor) || 0;
      const slice = tools.slice(start, start + pageSize);
      const nextCursor = start + pageSize < tools.length ? start + pageSize : undefined;
      respond(message.id, {
        tools: slice,
        nextCursor
      });
      return;
    }

    if (message.method === 'tools/call') {
      const name = message.params?.name;
      if (name === 'ping') {
        respond(message.id, { content: { result: 'pong' } });
        return;
      }
      if (name === 'echo') {
        respond(message.id, {
          content: {
            result: message.params?.arguments?.text ?? null
          }
        });
        return;
      }
      if (name === 'stream') {
        const chunks = message.params?.arguments?.chunks ?? [];
        respond(message.id, {
          content: {
            stream: chunks
          }
        });
        return;
      }
      if (name === 'slow') {
        const delay = Number(message.params?.arguments?.delayMs ?? 100);
        setTimeout(() => {
          respond(message.id, {
            content: {
              result: `completed in ${delay}ms`
            }
          });
        }, delay);
        return;
      }
      respondError(message.id, `Unknown tool: ${name}`);
      return;
    }

    if (message.method === 'tools/call_stream') {
      const chunks = message.params?.arguments?.chunks ?? [];
      respond(message.id, {
        chunks
      });
      return;
    }

    respondError(message.id, `Unsupported method ${message.method}`);
  } catch (error) {
    respondError(0, error.message);
  }
});

process.on('SIGINT', () => process.exit(0));
