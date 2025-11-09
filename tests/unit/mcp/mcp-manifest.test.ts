import { parseMCPManifest } from '@/mcp/mcp-manifest.ts';
import { ManifestError } from '@/core/errors.ts';

describe('mcp/mcp-manifest', () => {
  test('parses standard wrapper manifest with optional fields', () => {
    const manifest = {
      mcpServers: {
        search: {
          command: 'npx',
          args: ['-y', 'mcp-search'],
          env: {
            API_KEY: '${API_KEY}'
          },
          description: 'Search MCP',
          autoStart: false,
          capabilities: { foo: 'bar' },
          requestTimeoutMs: 45000
        }
      }
    };

    const result = parseMCPManifest(manifest, 'search.json');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'search',
      command: 'npx',
      args: ['-y', 'mcp-search'],
      env: { API_KEY: '${API_KEY}' },
      description: 'Search MCP',
      autoStart: false,
      capabilities: { foo: 'bar' },
      requestTimeoutMs: 45000
    });
  });

  test('parses flat manifest map', () => {
    const manifest = {
      reader: {
        command: 'node',
        args: ['server.mjs']
      }
    };

    const result = parseMCPManifest(manifest, 'reader.json');
    expect(result).toEqual([
      {
        id: 'reader',
        command: 'node',
        args: ['server.mjs'],
        env: undefined,
        description: undefined,
        autoStart: undefined,
        capabilities: undefined,
        requestTimeoutMs: undefined
      }
    ]);
  });

  test('throws when manifest is not an object', () => {
    expect(() => parseMCPManifest('invalid', 'invalid.json')).toThrow(ManifestError);
  });

  test('throws when mcpServers wrapper is not an object', () => {
    expect(() =>
      parseMCPManifest(
        {
          mcpServers: null as unknown as Record<string, any>
        },
        'bad-wrapper.json'
      )
    ).toThrow(/must define servers as a JSON object/);
  });

  test('throws when server entry is not an object', () => {
    expect(() =>
      parseMCPManifest(
        {
          mcpServers: {
            bad: null
          }
        },
        'bad.json'
      )
    ).toThrow(/must be an object/);
  });

  test('throws when command missing or invalid', () => {
    expect(() =>
      parseMCPManifest(
        {
          bad: {}
        },
        'bad.json'
      )
    ).toThrow(/must include a non-empty string 'command'/);
  });

  test('throws when args is not array of strings', () => {
    expect(() =>
      parseMCPManifest(
        {
          bad: {
            command: 'node',
            args: 'invalid'
          }
        },
        'bad.json'
      )
    ).toThrow(/must define 'args' as an array of strings/);
  });

  test('throws when env values are not strings', () => {
    expect(() =>
      parseMCPManifest(
        {
          bad: {
            command: 'node',
            env: {
              TOKEN: 123
            }
          }
        },
        'bad.json'
      )
    ).toThrow(/must define environment variables as strings/);
  });

  test('throws when env is not an object', () => {
    expect(() =>
      parseMCPManifest(
        {
          bad: {
            command: 'node',
            env: 'invalid'
          }
        },
        'bad.json'
      )
    ).toThrow(/must define 'env' as an object/);
  });

  test('throws when capabilities is not object', () => {
    expect(() =>
      parseMCPManifest(
        {
          bad: {
            command: 'node',
            capabilities: 'invalid'
          }
        },
        'bad.json'
      )
    ).toThrow(/must define 'capabilities' as an object/);
  });

  test('throws when requestTimeoutMs is not a number', () => {
    expect(() =>
      parseMCPManifest(
        {
          bad: {
            command: 'node',
            requestTimeoutMs: '1000'
          }
        },
        'bad.json'
      )
    ).toThrow(/must define 'requestTimeoutMs' as a number/);
  });

  test('throws when autoStart is not boolean', () => {
    expect(() =>
      parseMCPManifest(
        {
          bad: {
            command: 'node',
            autoStart: 'yes'
          }
        },
        'bad.json'
      )
    ).toThrow(/must define 'autoStart' as a boolean/);
  });

  test('throws when description is not string', () => {
    expect(() =>
      parseMCPManifest(
        {
          bad: {
            command: 'node',
            description: 42
          }
        },
        'bad.json'
      )
    ).toThrow(/must define 'description' as a string/);
  });

  test('throws when manifest has no servers', () => {
    expect(() =>
      parseMCPManifest(
        {
          mcpServers: {}
        },
        'empty.json'
      )
    ).toThrow(/must define at least one server/);
  });
});
