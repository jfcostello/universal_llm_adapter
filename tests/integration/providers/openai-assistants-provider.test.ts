import { jest } from '@jest/globals';
import { AzureOpenAI } from 'openai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import OpenAIAssistantsCompat from '@/plugins/compat/openai-assistants/index.ts';
import { Role } from '@/kernel/index.ts';

describe('integration/providers/openai-assistants-provider', () => {
  let compat: OpenAIAssistantsCompat;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-openai-api-key';
    compat = new OpenAIAssistantsCompat();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.OPENAI_API_VERSION;
  });

  describe('SDK Initialization Tests', () => {
    test('initializes compat with SDK methods', () => {
      expect(compat).toBeDefined();
      expect(compat.callSDK).toBeDefined();
    });

    test('getSDKClient extracts API key from headers.Authorization', () => {
      const headers = { Authorization: 'Bearer test-key-from-headers' };
      const client = (compat as any).getSDKClient(headers);
      expect(client).toBeDefined();
    });

    test('getSDKClient extracts API key from lowercase headers.authorization', () => {
      delete process.env.OPENAI_API_KEY;
      const headers = { authorization: 'Bearer test-key-from-headers' };
      const client = (compat as any).getSDKClient(headers as any);
      expect(client).toBeDefined();
      process.env.OPENAI_API_KEY = 'test-openai-api-key';
    });

    test('getSDKClient falls back to OPENAI_API_KEY', () => {
      const client = (compat as any).getSDKClient();
      expect(client).toBeDefined();
    });

    test('getSDKClient throws when no API key available', () => {
      delete process.env.OPENAI_API_KEY;
      expect(() => (compat as any).getSDKClient()).toThrow('API key required');
      process.env.OPENAI_API_KEY = 'test-openai-api-key';
    });

    test('getSDKClient uses AzureOpenAI when api-key headers are provided', () => {
      const client = (compat as any).getSDKClient({
        'api-key': 'test-azure-key',
        'x-azure-endpoint': 'https://example-resource.openai.azure.com',
        'x-openai-api-version': '2024-05-01-preview'
      } as any);

      expect(client).toBeDefined();
      expect(client).toBeInstanceOf(AzureOpenAI);
    });

    test('getSDKClient uses AzureOpenAI with case-insensitive Azure headers', () => {
      delete process.env.OPENAI_API_KEY;
      const client = (compat as any).getSDKClient({
        'API-KEY': 'test-azure-key',
        'X-AZURE-ENDPOINT': 'https://example-resource.openai.azure.com',
        'X-OPENAI-API-VERSION': '2024-05-01-preview'
      } as any);

      expect(client).toBeDefined();
      expect(client).toBeInstanceOf(AzureOpenAI);
      process.env.OPENAI_API_KEY = 'test-openai-api-key';
    });

    test('getSDKClient uses Azure env fallbacks for endpoint and api version', () => {
      process.env.AZURE_OPENAI_ENDPOINT = 'https://example-resource.openai.azure.com';
      process.env.OPENAI_API_VERSION = '2024-05-01-preview';

      const client = (compat as any).getSDKClient({
        'api-key': 'test-azure-key'
      } as any);

      expect(client).toBeDefined();
      expect(client).toBeInstanceOf(AzureOpenAI);
    });

    test('getSDKClient throws when Azure endpoint missing', () => {
      expect(() =>
        (compat as any).getSDKClient({
          'api-key': 'test-azure-key',
          'x-openai-api-version': '2024-05-01-preview'
        } as any)
      ).toThrow('Azure endpoint required');
    });

    test('getSDKClient throws when Azure api version missing', () => {
      expect(() =>
        (compat as any).getSDKClient({
          'api-key': 'test-azure-key',
          'x-azure-endpoint': 'https://example-resource.openai.azure.com'
        } as any)
      ).toThrow('Azure API version required');
    });
  });

  describe('Non-stream SDK call orchestration', () => {
    test('HTTP compatibility methods are present (buildPayload + parseResponse)', () => {
      const payload = compat.buildPayload(
        'gpt-4.1-mini',
        { assistantId: 'asst_test' } as any,
        [{ role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }],
        [],
        undefined
      );

      expect(payload).toEqual(
        expect.objectContaining({
          assistant_id: 'asst_test',
          model: 'gpt-4.1-mini'
        })
      );

      const response = {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'ok' }]
      } as any;
      expect(compat.parseResponse(response, 'gpt-4.1-mini')).toEqual(response);
    });

    test('serializeTools and serializeToolChoice expose expected shapes', () => {
      expect(
        compat.serializeTools([
          { name: 't1', description: 'd1', parametersJsonSchema: { type: 'object', properties: {} } }
        ])
      ).toEqual({
        tools: [
          {
            type: 'function',
            function: {
              name: 't1',
              description: 'd1',
              parameters: { type: 'object', properties: {} }
            }
          }
        ]
      });

      expect(compat.serializeTools([{ name: 't1', description: 'd1' } as any])).toEqual({
        tools: [
          {
            type: 'function',
            function: {
              name: 't1',
              description: 'd1',
              parameters: { type: 'object', properties: {} }
            }
          }
        ]
      });

      expect(compat.serializeTools([])).toEqual({});

      expect(compat.serializeToolChoice('auto')).toEqual({ tool_choice: 'auto' });
      expect(compat.serializeToolChoice('none')).toEqual({ tool_choice: 'none' });
      expect(compat.serializeToolChoice(undefined)).toEqual({});
      expect(compat.serializeToolChoice({ type: 'unknown' } as any)).toEqual({});
    });

    test('buildPayload supports tool filtering for toolChoice', () => {
      const base = [{ role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }];
      const tools = [
        { name: 't1', description: 'd1', parametersJsonSchema: { type: 'object', properties: {} } },
        { name: 't2', description: 'd2', parametersJsonSchema: { type: 'object', properties: {} } },
        { name: 't3', description: 'd3', parametersJsonSchema: { type: 'object', properties: {} } }
      ];

      expect(
        compat.buildPayload('gpt-4.1-mini', { assistantId: 'asst_test' } as any, base as any, tools as any, 'none')
      ).toEqual(expect.objectContaining({ tool_choice: 'none' }));

      expect(
        compat.buildPayload(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' } as any,
          base as any,
          tools as any,
          { type: 'single', name: 't2' } as any
        )
      ).toEqual(
        expect.objectContaining({
          tool_choice: { type: 'function', function: { name: 't2' } },
          tools: [
            {
              type: 'function',
              function: expect.objectContaining({ name: 't2' })
            }
          ]
        })
      );

      expect(
        compat.buildPayload(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' } as any,
          base as any,
          tools as any,
          { type: 'required', allowed: ['t1', 't3'] } as any
        )
      ).toEqual(
        expect.objectContaining({
          tool_choice: 'required',
          tools: [
            { type: 'function', function: expect.objectContaining({ name: 't1' }) },
            { type: 'function', function: expect.objectContaining({ name: 't3' }) }
          ]
        })
      );

      expect(
        compat.buildPayload(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' } as any,
          base as any,
          tools as any,
          { type: 'required', allowed: ['t1'] } as any
        )
      ).toEqual(
        expect.objectContaining({
          tool_choice: { type: 'function', function: { name: 't1' } }
        })
      );
    });

    test('buildPayload serializes images and ignores empty system instructions', () => {
      const payload = compat.buildPayload(
        'gpt-4.1-mini',
        { assistantId: 'asst_test' } as any,
        [
          { role: Role.SYSTEM, content: [] },
          {
            role: Role.USER,
            content: [
              { type: 'text', text: 'Look' },
              { type: 'image', imageUrl: 'https://example.com/image.png' }
            ]
          }
        ] as any,
        [],
        undefined
      );

      expect(payload.instructions).toBeUndefined();
      expect(payload.thread.messages[0].content).toEqual([
        { type: 'text', text: 'Look' },
        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
      ]);
    });

    test('buildPayload ignores empty system text parts', () => {
      const payload = compat.buildPayload(
        'gpt-4.1-mini',
        { assistantId: 'asst_test' } as any,
        [
          { role: Role.SYSTEM, content: [{ type: 'text' } as any] },
          { role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }
        ] as any,
        [],
        undefined
      );

      expect(payload.instructions).toBeUndefined();
    });

    test('buildPayload maps additional settings and omits file_search tool when toolChoice is required', () => {
      const payload = compat.buildPayload(
        'gpt-4.1-mini',
        { assistantId: 'asst_test', topP: 0.9, maxTokens: 123, responseFormat: 'json_object' } as any,
        [
          {
            role: Role.USER,
            content: [
              { type: 'text', text: 'Use the doc.' },
              { type: 'document', source: { type: 'file_id', fileId: 'file_abc' } } as any
            ]
          }
        ] as any,
        [{ name: 't1', description: 'd1' } as any],
        'required'
      );

      expect(payload).toEqual(
        expect.objectContaining({
          top_p: 0.9,
          max_completion_tokens: 123,
          response_format: { type: 'json_object' },
          tool_choice: 'required'
        })
      );

      // Tool choice "required" disables auto-including file_search tool.
      expect(payload.tools).toEqual([
        {
          type: 'function',
          function: expect.objectContaining({
            name: 't1',
            parameters: { type: 'object', properties: {} }
          })
        }
      ]);
    });

    test('buildPayload serializes assistant messages and document placeholders with defaults', () => {
      const payload = compat.buildPayload(
        'gpt-4.1-mini',
        { assistantId: 'asst_test' } as any,
        [
          { role: Role.ASSISTANT, content: [] },
          {
            role: Role.USER,
            content: [{ type: 'document', source: { type: 'file_id', fileId: 'file_abc' } } as any]
          }
        ] as any,
        [],
        undefined
      );

      expect(payload.thread.messages).toEqual([
        { role: 'assistant', content: '' },
        {
          role: 'user',
          content: [{ type: 'text', text: '\n\n[Document attached: document (unknown)]' }]
        }
      ]);
    });

    test('callSDK rejects URL document sources (Decision A)', async () => {
      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn(),
            messages: { list: jest.fn() }
          }
        },
        files: { create: jest.fn() }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        await expect(
          compat.callSDK?.(
            'gpt-4.1-mini',
            { assistantId: 'asst_test' },
            [
              {
                role: Role.USER,
                content: [
                  {
                    type: 'document',
                    source: { type: 'url', url: 'https://example.com/doc.pdf' },
                    mimeType: 'application/pdf',
                    filename: 'doc.pdf'
                  } as any
                ]
              }
            ] as any,
            []
          )
        ).rejects.toThrow('DocumentContent.source.type "url"');

        expect(mockClient.files.create).not.toHaveBeenCalled();
        expect(mockClient.beta.threads.createAndRunPoll).not.toHaveBeenCalled();
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK uploads base64 documents and attaches file_search resources', async () => {
      const mockRun = {
        id: 'run_docs',
        thread_id: 'thread_docs',
        status: 'completed',
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      };

      const mockMessages = {
        data: [
          {
            id: 'msg_docs',
            role: 'assistant',
            content: [
              { type: 'text', text: { value: 'ok', annotations: [] } }
            ]
          }
        ]
      };

      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue(mockRun),
            messages: {
              list: jest.fn().mockResolvedValue(mockMessages)
            }
          }
        },
        files: {
          create: jest.fn().mockResolvedValue({ id: 'file_1' })
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        await compat.callSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' },
          [
            {
              role: Role.USER,
              content: [
                { type: 'text', text: 'Use the document.' },
                {
                  type: 'document',
                  source: { type: 'base64', data: 'ZmlsZQ==' },
                  mimeType: 'application/pdf',
                  filename: 'doc.pdf'
                } as any
              ]
            }
          ] as any,
          []
        );

        expect(mockClient.files.create).toHaveBeenCalledWith(
          expect.objectContaining({ purpose: 'assistants' })
        );

        expect(mockClient.beta.threads.createAndRunPoll).toHaveBeenCalledWith(
          expect.objectContaining({
            thread: expect.objectContaining({
              tool_resources: {
                file_search: {
                  vector_stores: [{ file_ids: ['file_1'] }]
                }
              }
            }),
            tools: [{ type: 'file_search' }]
          }),
          undefined
        );
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK accepts file_id documents without uploading', async () => {
      const mockRun = {
        id: 'run_file_id',
        thread_id: 'thread_file_id',
        status: 'completed'
      };

      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue(mockRun),
            messages: {
              list: jest.fn().mockResolvedValue({ data: [] })
            }
          }
        },
        files: {
          create: jest.fn()
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        await compat.callSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' },
          [
            {
              role: Role.USER,
              content: [
                {
                  type: 'document',
                  source: { type: 'file_id', fileId: 'file_abc' },
                  mimeType: 'application/pdf',
                  filename: 'doc.pdf'
                } as any
              ]
            }
          ] as any,
          []
        );

        expect(mockClient.files.create).not.toHaveBeenCalled();
        expect(mockClient.beta.threads.createAndRunPoll).toHaveBeenCalledWith(
          expect.objectContaining({
            thread: expect.objectContaining({
              tool_resources: {
                file_search: {
                  vector_stores: [{ file_ids: ['file_abc'] }]
                }
              }
            })
          }),
          undefined
        );
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK creates a thread+run and returns assistant content when run completes', async () => {
      const mockRun = {
        id: 'run_1',
        thread_id: 'thread_1',
        status: 'completed',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      };

      const mockMessages = {
        data: [
          {
            id: 'msg_1',
            role: 'assistant',
            content: [
              { type: 'text', text: { value: 'Hello from assistants!', annotations: [] } }
            ]
          }
        ]
      };

      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue(mockRun),
            messages: {
              list: jest.fn().mockResolvedValue(mockMessages)
            }
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const result = await compat.callSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test', temperature: 0.2 },
          [
            { role: Role.SYSTEM, content: [{ type: 'text', text: 'System prompt' }] },
            { role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }
          ],
          [],
          undefined
        );

        expect(mockClient.beta.threads.createAndRunPoll).toHaveBeenCalledWith(
          expect.objectContaining({
            assistant_id: 'asst_test',
            model: 'gpt-4.1-mini',
            instructions: 'System prompt',
            temperature: 0.2,
            thread: {
              messages: [
                { role: 'user', content: [{ type: 'text', text: 'Hi' }] }
              ]
            }
          }),
          undefined
        );
        expect(mockClient.beta.threads.messages.list).toHaveBeenCalledWith(
          'thread_1',
          expect.any(Object)
        );
        expect(result?.content).toEqual([{ type: 'text', text: 'Hello from assistants!' }]);
        expect(result?.usage?.promptTokens).toBe(10);
        expect(result?.usage?.completionTokens).toBe(5);
        expect(result?.usage?.totalTokens).toBe(15);
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK returns tool calls when run requires submit_tool_outputs', async () => {
      const mockRun = {
        id: 'run_2',
        thread_id: 'thread_2',
        status: 'requires_action',
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{\"city\":\"SF\"}' }
              }
            ]
          }
        },
        usage: null
      };

      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue(mockRun),
            messages: {
              list: jest.fn()
            }
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const logger = { info: jest.fn() };
        const result = await compat.callSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' },
          [{ role: Role.USER, content: [{ type: 'text', text: 'Call the tool' }] }],
          [{ name: 'get_weather', description: 'Get weather', parametersJsonSchema: { type: 'object', properties: {} } }],
          undefined,
          logger
        );

        expect(logger.info).toHaveBeenCalled();
        expect(result?.toolCalls?.[0]).toMatchObject({
          id: 'call_1',
          name: 'get_weather',
          arguments: { city: 'SF' },
          metadata: { threadId: 'thread_2', runId: 'run_2' }
        });
        expect(mockClient.beta.threads.messages.list).not.toHaveBeenCalled();
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK returns finishReason tool_calls but omits toolCalls when none are parsable', async () => {
      const mockRun = {
        id: 'run_empty_tools',
        thread_id: 'thread_empty_tools',
        status: 'requires_action',
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [{ type: 'not_function' }]
          }
        }
      };

      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue(mockRun),
            messages: {
              list: jest.fn()
            }
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const result = await compat.callSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' },
          [{ role: Role.USER, content: [{ type: 'text', text: 'Call a tool' }] }],
          []
        );

        expect(result?.finishReason).toBe('tool_calls');
        expect(result?.toolCalls).toBeUndefined();
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK submits tool outputs on follow-up call and returns final content', async () => {
      const mockRunAfterSubmit = {
        id: 'run_3',
        thread_id: 'thread_3',
        status: 'completed',
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      };

      const mockMessages = {
        data: [
          {
            id: 'msg_3',
            role: 'assistant',
            content: [
              { type: 'text', text: { value: 'Done!', annotations: [] } }
            ]
          }
        ]
      };

      const mockClient = {
        beta: {
          threads: {
            runs: {
              submitToolOutputsAndPoll: jest.fn().mockResolvedValue(mockRunAfterSubmit)
            },
            messages: {
              list: jest.fn().mockResolvedValue(mockMessages)
            }
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const result = await compat.callSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' },
          [
            {
              role: Role.ASSISTANT,
              content: [],
              toolCalls: [
                {
                  id: 'call_3',
                  name: 'get_weather',
                  arguments: { city: 'SF' },
                  metadata: { threadId: 'thread_3', runId: 'run_3' }
                }
              ]
            },
            {
              role: Role.TOOL,
              toolCallId: 'call_3',
              content: [
                { type: 'text', text: 'Sunny' },
                { type: 'tool_result', toolName: 'get_weather', result: { ok: true } }
              ]
            }
          ],
          [{ name: 'get_weather', parametersJsonSchema: { type: 'object', properties: {} } }],
          undefined
        );

        expect(mockClient.beta.threads.runs.submitToolOutputsAndPoll).toHaveBeenCalledWith(
          'run_3',
          {
            thread_id: 'thread_3',
            tool_outputs: [{ tool_call_id: 'call_3', output: 'Sunny' }]
          },
          undefined
        );
        expect(result?.content).toEqual([{ type: 'text', text: 'Done!' }]);
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK does not treat old tool cycles as follow-up when conversation has continued', async () => {
      const mockRun = {
        id: 'run_new',
        thread_id: 'thread_new',
        status: 'completed'
      };

      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue(mockRun),
            runs: {
              submitToolOutputsAndPoll: jest.fn()
            },
            messages: {
              list: jest.fn().mockResolvedValue({ data: [] })
            }
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        await compat.callSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' } as any,
          [
            {
              role: Role.ASSISTANT,
              content: [],
              toolCalls: [
                {
                  id: 'call_1',
                  name: 't1',
                  arguments: { a: 1 },
                  metadata: { threadId: 'thread_old', runId: 'run_old' }
                }
              ]
            },
            {
              role: Role.TOOL,
              toolCallId: 'call_1',
              content: [
                { type: 'text', text: 'ok' },
                { type: 'tool_result', toolName: 't1', result: { ok: true } }
              ]
            },
            {
              role: Role.USER,
              content: [{ type: 'text', text: 'New question' }]
            }
          ] as any,
          []
        );

        expect(mockClient.beta.threads.runs.submitToolOutputsAndPoll).not.toHaveBeenCalled();
        expect(mockClient.beta.threads.createAndRunPoll).toHaveBeenCalled();
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK throws when assistantId missing', async () => {
      await expect(
        compat.callSDK?.('gpt-4.1-mini', {}, [{ role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }], [])
      ).rejects.toThrow('assistantId');
    });

    test('callSDK throws when run fails', async () => {
      const mockRun = {
        id: 'run_fail',
        thread_id: 'thread_fail',
        status: 'failed',
        last_error: { message: 'Boom', code: 'server_error' }
      };

      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue(mockRun)
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        await expect(
          compat.callSDK?.(
            'gpt-4.1-mini',
            { assistantId: 'asst_test' },
            [{ role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }],
            []
          )
        ).rejects.toThrow('Boom');
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK returns content for incomplete runs', async () => {
      const mockRun = {
        id: 'run_incomplete',
        thread_id: 'thread_incomplete',
        status: 'incomplete',
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      };

      const mockMessages = {
        data: [
          {
            id: 'msg_incomplete',
            role: 'assistant',
            content: [
              { type: 'text', text: { value: 'Partial', annotations: [] } }
            ]
          }
        ]
      };

      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue(mockRun),
            messages: {
              list: jest.fn().mockResolvedValue(mockMessages)
            }
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const result = await compat.callSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' },
          [{ role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }],
          []
        );

        expect(result?.finishReason).toBe('incomplete');
        expect(result?.content).toEqual([{ type: 'text', text: 'Partial' }]);
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK falls back to empty assistant content when messages list is malformed', async () => {
      const mockRun = {
        id: 'run_malformed',
        thread_id: 'thread_malformed',
        status: 'completed',
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      };

      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue(mockRun),
            messages: {
              list: jest.fn().mockResolvedValue({ data: 'nope' })
            }
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const result = await compat.callSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' },
          [{ role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }],
          []
        );

        expect(result?.content).toEqual([{ type: 'text', text: '' }]);
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK throws when run ends without last_error', async () => {
      const mockRun = {
        id: 'run_cancelled',
        thread_id: 'thread_cancelled',
        status: 'cancelled'
      };

      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue(mockRun)
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        await expect(
          compat.callSDK?.(
            'gpt-4.1-mini',
            { assistantId: 'asst_test' },
            [{ role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }],
            []
          )
        ).rejects.toThrow('Run ended with status: cancelled');
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK throws default unknown status when run is missing status', async () => {
      const mockClient = {
        beta: {
          threads: {
            createAndRunPoll: jest.fn().mockResolvedValue({})
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        await expect(
          compat.callSDK?.(
            'gpt-4.1-mini',
            { assistantId: 'asst_test' },
            [{ role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }],
            []
          )
        ).rejects.toThrow('Run ended with status: unknown');
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });
  });

  describe('Streaming interface scaffolding', () => {
    test('parseStreamChunk and getStreamingFlags are callable', () => {
      expect(compat.getStreamingFlags()).toEqual({ stream: true });
      expect(compat.parseStreamChunk({})).toEqual({});
    });

    test('parseStreamChunk handles malformed inputs and error events', () => {
      expect(compat.parseStreamChunk(null)).toEqual({});

      expect(
        compat.parseStreamChunk({
          event: 'thread.message.delta',
          data: { delta: { content: 'nope' } }
        })
      ).toEqual({});

      expect(
        compat.parseStreamChunk({
          event: 'thread.message.delta',
          data: { delta: { content: [{ type: 'text', text: { value: 123 } }] } }
        })
      ).toEqual({});

      expect(
        compat.parseStreamChunk({
          event: 'thread.run.completed',
          data: {}
        })
      ).toEqual({});

      expect(() =>
        compat.parseStreamChunk({
          event: 'thread.run.failed',
          data: { last_error: { message: 'Boom' } }
        })
      ).toThrow('Boom');

      expect(() =>
        compat.parseStreamChunk({
          event: 'thread.run.cancelled',
          data: { message: 'Cancelled' }
        })
      ).toThrow('Cancelled');

      expect(() =>
        compat.parseStreamChunk({
          event: 'error',
          data: {}
        })
      ).toThrow('OpenAI Assistants stream ended with event: error');
    });

    test('parseStreamChunk extracts text deltas, tool calls, and usage', () => {
      expect(
        compat.parseStreamChunk({
          event: 'thread.message.delta',
          data: { delta: { content: [{ type: 'text', text: { value: 'Hi' } }] } }
        })
      ).toEqual({ text: 'Hi' });

      expect(
        compat.parseStreamChunk({
          event: 'thread.run.requires_action',
          data: {
            id: 'run_1',
            thread_id: 'thread_1',
            required_action: {
              type: 'submit_tool_outputs',
              submit_tool_outputs: {
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 't1', arguments: '{\"a\":1}' } }
                ]
              }
            }
          }
        })
      ).toEqual(
        expect.objectContaining({
          finishedWithToolCalls: true,
          toolEvents: expect.arrayContaining([
            expect.objectContaining({ type: 'tool_call_start', callId: 'call_1', name: 't1' }),
            expect.objectContaining({ type: 'tool_call_end', callId: 'call_1', arguments: '{\"a\":1}' })
          ])
        })
      );

      expect(
        compat.parseStreamChunk({
          event: 'thread.run.completed',
          data: { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }
        })
      ).toEqual({ usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });
    });

    test('parseStreamChunk handles requires_action tool_calls edge cases', () => {
      expect(
        compat.parseStreamChunk({
          event: 'thread.run.requires_action',
          data: {
            id: 'run_1',
            thread_id: 'thread_1',
            required_action: {
              type: 'submit_tool_outputs',
              submit_tool_outputs: {
                tool_calls: [
                  null,
                  { id: 'call_ignore', type: 'not_function' },
                  { id: '', type: 'function', function: { name: 't1', arguments: '{}' } },
                  { id: 'call_2', type: 'function', function: { name: 123, arguments: 123 } }
                ]
              }
            }
          }
        })
      ).toEqual(
        expect.objectContaining({
          finishedWithToolCalls: true,
          toolEvents: expect.arrayContaining([
            expect.objectContaining({ type: 'tool_call_start', callId: 'call_2', name: undefined }),
            expect.objectContaining({ type: 'tool_call_end', callId: 'call_2', name: undefined, arguments: '' })
          ])
        })
      );

      expect(
        compat.parseStreamChunk({
          event: 'thread.run.requires_action',
          data: {
            id: 'run_2',
            thread_id: 'thread_2',
            required_action: {
              type: 'submit_tool_outputs',
              submit_tool_outputs: {
                tool_calls: [{ id: '', type: 'function', function: { name: 't1', arguments: '{}' } }]
              }
            }
          }
        })
      ).toEqual({ finishedWithToolCalls: true });
    });

    test('streamSDK throws when assistantId missing', async () => {
      const gen = compat.streamSDK?.(
        'gpt-4.1-mini',
        {},
        [{ role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }],
        []
      ) as any;

      await expect(gen.next()).rejects.toThrow('assistantId');
    });

    test('streamSDK yields events from SDK streams (createAndRunStream + submitToolOutputsStream)', async () => {
      async function* mockInitialStream() {
        yield { event: 'thread.message.delta', data: { delta: { content: [{ type: 'text', text: { value: 'Hello' } }] } } };
        yield { event: 'thread.run.completed', data: { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } };
      }

      async function* mockToolStream() {
        yield { event: 'thread.run.completed', data: { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } };
      }

      const mockClient = {
        beta: {
          threads: {
            createAndRunStream: jest.fn().mockReturnValue(mockInitialStream()),
            runs: {
              submitToolOutputsStream: jest.fn().mockReturnValue(mockToolStream())
            }
          }
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const logger = { info: jest.fn() };
        const events: any[] = [];
        for await (const event of compat.streamSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' },
          [{ role: Role.USER, content: [{ type: 'text', text: 'Hi' }] }],
          [],
          undefined,
          logger
        ) as any) {
          events.push(event);
        }

        expect(events).toHaveLength(2);
        expect(logger.info).toHaveBeenCalled();
        expect(mockClient.beta.threads.createAndRunStream).toHaveBeenCalled();

        const followUpEvents: any[] = [];
        for await (const event of compat.streamSDK?.(
          'gpt-4.1-mini',
          { assistantId: 'asst_test' },
          [
            {
              role: Role.ASSISTANT,
              content: [],
              toolCalls: [
                {
                  id: 'call_3',
                  name: 't1',
                  arguments: { a: 1 },
                  metadata: { threadId: 'thread_3', runId: 'run_3' }
                }
              ]
            },
            {
              role: Role.TOOL,
              toolCallId: 'call_3',
              content: [
                { type: 'text', text: 'ok' },
                { type: 'tool_result', toolName: 't1', result: { ok: true } }
              ]
            }
          ],
          [],
          undefined
        ) as any) {
          followUpEvents.push(event);
        }

        expect(followUpEvents).toHaveLength(1);
        expect(mockClient.beta.threads.runs.submitToolOutputsStream).toHaveBeenCalled();
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });
  });

  describe('Private helper coverage', () => {
    test('buildToolsAndChoice uses default options when omitted', () => {
      const result = (compat as any).buildToolsAndChoice(
        [{ name: 't1', description: 'd1', parametersJsonSchema: { type: 'object', properties: {} } }],
        undefined
      );

      expect(result.sdkTools).toEqual([
        {
          type: 'function',
          function: {
            name: 't1',
            description: 'd1',
            parameters: { type: 'object', properties: {} }
          }
        }
      ]);
      expect(result.sdkToolChoice).toBeUndefined();
    });

    test('parseRequiredActionToolCalls returns empty array when tool_calls not array', () => {
      expect((compat as any).parseRequiredActionToolCalls({
        id: 'run',
        thread_id: 'thread',
        required_action: {
          submit_tool_outputs: {
            tool_calls: 'nope'
          }
        }
      })).toEqual([]);
    });

    test('parseRequiredActionToolCalls handles missing fields and invalid JSON', () => {
      expect(
        (compat as any).parseRequiredActionToolCalls({
          id: 'run',
          thread_id: 'thread',
          required_action: {
            submit_tool_outputs: {
              tool_calls: [
                { type: 'function', function: { arguments: '{nope' } }
              ]
            }
          }
        })
      ).toEqual([
        expect.objectContaining({
          id: 'call_0',
          name: '',
          arguments: {},
          metadata: { threadId: 'thread', runId: 'run' }
        })
      ]);
    });

    test('parseRequiredActionToolCalls returns empty array when required_action is missing', () => {
      expect((compat as any).parseRequiredActionToolCalls({ id: 'run', thread_id: 'thread' })).toEqual([]);
    });

    test('responseFromRun omits toolCalls when parsed toolCalls are empty', async () => {
      const result = await (compat as any).responseFromRun(
        {} as any,
        {
          id: 'run',
          thread_id: 'thread',
          status: 'requires_action',
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [{ type: 'not_function' }]
            }
          }
        },
        'gpt-4.1-mini'
      );

      expect(result.finishReason).toBe('tool_calls');
      expect(result.toolCalls).toBeUndefined();
    });

    test('extractToolSubmissionContext skips irrelevant tool messages', () => {
      expect((compat as any).extractToolSubmissionContext([
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call_1', name: 't1', arguments: {}, metadata: { threadId: 't', runId: 'r' } }]
        },
        {
          role: Role.TOOL,
          toolCallId: 'call_other',
          content: [
            { type: 'text', text: 'nope' },
            { type: 'tool_result', toolName: 't1', result: { ok: true } }
          ]
        },
        {
          role: Role.TOOL,
          toolCallId: 'call_1',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_result', toolName: 't1', result: { ok: true } }
          ]
        }
      ])).toEqual({
        threadId: 't',
        runId: 'r',
        toolOutputs: [{ tool_call_id: 'call_1', output: 'ok' }]
      });
    });

    test('extractToolSubmissionContext returns null when a new user message appears after tool results', () => {
      expect((compat as any).extractToolSubmissionContext([
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call_1', name: 't1', arguments: {}, metadata: { threadId: 't', runId: 'r' } }]
        },
        {
          role: Role.TOOL,
          toolCallId: 'call_1',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_result', toolName: 't1', result: { ok: true } }
          ]
        },
        {
          role: Role.USER,
          content: [{ type: 'text', text: 'New question' }]
        }
      ])).toBeNull();
    });

    test('extractToolSubmissionContext ignores tool budget final prompt user message', () => {
      expect((compat as any).extractToolSubmissionContext([
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call_1', name: 't1', arguments: {}, metadata: { threadId: 't', runId: 'r' } }]
        },
        {
          role: Role.TOOL,
          toolCallId: 'call_1',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_result', toolName: 't1', result: { ok: true } }
          ]
        },
        {
          role: Role.USER,
          content: [
            {
              type: 'text',
              text: 'All tool calls have been consumed (1 of 1). Provide your final response using the information gathered so far.'
            }
          ]
        }
      ])).toEqual({
        threadId: 't',
        runId: 'r',
        toolOutputs: [{ tool_call_id: 'call_1', output: 'ok' }]
      });
    });

    test('extractToolSubmissionContext returns null when metadata missing or tool outputs missing', () => {
      expect((compat as any).extractToolSubmissionContext([
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call_1', name: 't1', arguments: {} }]
        }
      ])).toBeNull();

      expect((compat as any).extractToolSubmissionContext([
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call_1', name: 't1', arguments: {}, metadata: { threadId: 't', runId: 'r' } }]
        }
      ])).toBeNull();
    });

    test('collectDocumentFileIds tolerates messages with missing content', async () => {
      const client = { files: { create: jest.fn() } };
      const ids = await (compat as any).collectDocumentFileIds(client, [{ role: Role.USER } as any]);
      expect(ids).toEqual([]);
      expect(client.files.create).not.toHaveBeenCalled();
    });

    test('collectDocumentFileIds uploads filepath documents', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ula-assistants-'));
      const filePath = path.join(tmpDir, 'doc.txt');
      fs.writeFileSync(filePath, 'hello');

      const client = {
        files: {
          create: jest.fn().mockResolvedValue({ id: 'file_fp' })
        }
      };

      try {
        const ids = await (compat as any).collectDocumentFileIds(client, [
          {
            role: Role.USER,
            content: [
              { type: 'document', source: { type: 'filepath', path: filePath } } as any
            ]
          }
        ] as any);

        expect(ids).toEqual(['file_fp']);
        expect(client.files.create).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'assistants' }));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('collectDocumentFileIds uploads base64 documents even when data/filename are missing', async () => {
      const client = {
        files: {
          create: jest.fn().mockResolvedValue({ id: 'file_b64' })
        }
      };

      const ids = await (compat as any).collectDocumentFileIds(client, [
        {
          role: Role.USER,
          content: [
            { type: 'document', source: { type: 'base64' }, mimeType: 'application/pdf' } as any
          ]
        }
      ] as any);

      expect(ids).toEqual(['file_b64']);
      expect(client.files.create).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'assistants' }));
    });

    test('hasDocumentParts tolerates messages with missing content', () => {
      expect((compat as any).hasDocumentParts([{ role: Role.USER } as any])).toBe(false);
    });

    test('parseAssistantMessageContent handles refusal and missing content', () => {
      expect((compat as any).parseAssistantMessageContent(null)).toEqual([]);

      expect((compat as any).parseAssistantMessageContent({
        content: [{ type: 'refusal', refusal: 'No.' }]
      })).toEqual([{ type: 'text', text: 'No.' }]);
    });

    test('parseAssistantMessageContent falls back to empty strings for missing values', () => {
      expect(
        (compat as any).parseAssistantMessageContent({
          content: [{ type: 'text', text: {} }, { type: 'refusal' }]
        })
      ).toEqual([
        { type: 'text', text: '' },
        { type: 'text', text: '' }
      ]);
    });
  });
});
