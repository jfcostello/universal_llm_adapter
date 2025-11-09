import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const respond = (result) => {
    const response = {
      jsonrpc: '2.0',
      id: message.id,
      result
    };
    process.stdout.write(JSON.stringify(response) + '\n');
  };

  const respondError = (errorMessage) => {
    const response = {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message: errorMessage
      }
    };
    process.stdout.write(JSON.stringify(response) + '\n');
  };

  switch (message.method) {
    case 'initialize':
      // Validate MCP protocol requirements
      if (!message.params?.clientInfo) {
        respondError('Required field missing: clientInfo');
        return;
      }
      if (!message.params.clientInfo.name || !message.params.clientInfo.version) {
        respondError('clientInfo must contain name and version');
        return;
      }
      respond({
        protocolVersion: message.params.protocolVersion || '2025-03-26',
        capabilities: {},
        serverInfo: {
          name: 'mock-mcp-server',
          version: '1.0.0'
        }
      });
      break;
    case 'tools/list': {
      const cursor = message.params?.cursor;
      if (!cursor) {
        respond({
          tools: [
            {
              name: 'echo',
              description: 'Echo back arguments',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
            }
          ],
          nextCursor: 'next'
        });
      } else {
        respond({
          tools: [
            {
              name: 'math',
              description: 'Double value',
              input_schema: { type: 'object', properties: { value: { type: 'number' } } }
            }
          ]
        });
      }
      break;
    }
    case 'tools/call': {
      const args = message.params?.arguments || {};
      if (message.params?.name === 'math') {
        respond({ content: { doubled: (args.value || 0) * 2 } });
      } else {
        respond({ content: { echoed: args } });
      }
      break;
    }
    default:
      respond({});
  }
});
