import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { DocumentContent, Message, Role } from '@/core/types.ts';
import AnthropicCompat from '@/plugins/compat/anthropic.ts';
import OpenAICompat from '@/plugins/compat/openai.ts';
import GoogleCompat from '@/plugins/compat/google.ts';
import OpenAIResponsesCompat from '@/plugins/compat/openai-responses.ts';

describe('Document Serialization - Compat Modules', () => {
  describe('Anthropic', () => {
    let compat: AnthropicCompat;

    beforeEach(() => {
      compat = new AnthropicCompat();
    });

    it('should serialize base64 document content', () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: 'dGVzdA==' },
              mimeType: 'application/pdf',
              filename: 'test.pdf'
            }
          ]
        }
      ];

      const payload = compat.buildPayload('claude-3-5-sonnet-20241022', {}, messages as any, []);

      expect(payload.messages).toBeDefined();
      expect(payload.messages[0].content).toContainEqual({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'dGVzdA=='
        }
      });
    });

    it('should serialize URL document content', () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'url', url: 'https://example.com/doc.pdf' },
              mimeType: 'application/pdf'
            }
          ]
        }
      ];

      const payload = compat.buildPayload('claude-3-5-sonnet-20241022', {}, messages as any, []);

      expect(payload.messages[0].content).toContainEqual({
        type: 'document',
        source: {
          type: 'url',
          url: 'https://example.com/doc.pdf'
        }
      });
    });

    it('should serialize file_id document content', () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'file_id', fileId: 'file-abc123' },
              mimeType: 'application/pdf'
            }
          ]
        }
      ];

      const payload = compat.buildPayload('claude-3-5-sonnet-20241022', {}, messages as any, []);

      expect(payload.messages[0].content).toContainEqual({
        type: 'document',
        source: {
          type: 'file',
          file_id: 'file-abc123'
        }
      });
    });

    it('should include cache_control if provided', () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: 'dGVzdA==' },
              mimeType: 'application/pdf',
              providerOptions: {
                anthropic: {
                  cacheControl: { type: 'ephemeral' }
                }
              }
            }
          ]
        }
      ];

      const payload = compat.buildPayload('claude-3-5-sonnet-20241022', {}, messages as any, []);

      expect(payload.messages[0].content).toContainEqual({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'dGVzdA=='
        },
        cache_control: { type: 'ephemeral' }
      });
    });

    it('should handle mixed content types', () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            { type: 'text', text: 'Analyze this document' },
            {
              type: 'document',
              source: { type: 'base64', data: 'cGRmZGF0YQ==' },
              mimeType: 'application/pdf'
            },
            { type: 'text', text: 'What does it say?' }
          ]
        }
      ];

      const payload = compat.buildPayload('claude-3-5-sonnet-20241022', {}, messages as any, []);

      expect(payload.messages[0].content).toHaveLength(3);
      expect(payload.messages[0].content[0]).toEqual({ type: 'text', text: 'Analyze this document' });
      expect(payload.messages[0].content[1].type).toBe('document');
      expect(payload.messages[0].content[2]).toEqual({ type: 'text', text: 'What does it say?' });
    });
  });

  describe('OpenAI', () => {
    let compat: OpenAICompat;

    beforeEach(() => {
      compat = new OpenAICompat();
    });

    it('should serialize base64 document content with data URL prefix', () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: 'dGVzdA==' },
              mimeType: 'application/pdf',
              filename: 'test.pdf'
            }
          ]
        }
      ];

      const payload = compat.buildPayload('gpt-4o', {}, messages as any, []);

      expect(payload.messages).toBeDefined();
      expect(payload.messages[0].content).toContainEqual({
        type: 'file',
        file: {
          filename: 'test.pdf',
          file_data: 'data:application/pdf;base64,dGVzdA=='
        }
      });
    });

    it('should use default filename if not provided', () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: 'dGVzdA==' },
              mimeType: 'application/pdf'
            }
          ]
        }
      ];

      const payload = compat.buildPayload('gpt-4o', {}, messages as any, []);

      expect(payload.messages[0].content).toContainEqual({
        type: 'file',
        file: {
          filename: 'document',
          file_data: 'data:application/pdf;base64,dGVzdA=='
        }
      });
    });

    it('should serialize file_id document content', () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'file_id', fileId: 'file-abc123' },
              mimeType: 'application/pdf'
            }
          ]
        }
      ];

      const payload = compat.buildPayload('gpt-4o', {}, messages as any, []);

      expect(payload.messages[0].content).toContainEqual({
        type: 'file',
        file: {
          file_id: 'file-abc123'
        }
      });
    });

    it('should throw error for URL source (not supported)', () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'url', url: 'https://example.com/doc.pdf' },
              mimeType: 'application/pdf'
            }
          ]
        }
      ];

      expect(() => {
        compat.buildPayload('gpt-4o', {}, messages as any, []);
      }).toThrow('OpenAI Chat Completions does not support file URLs');
    });

    it('should handle mixed content types', () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            { type: 'text', text: 'Review this document' },
            {
              type: 'document',
              source: { type: 'base64', data: 'cGRmZGF0YQ==' },
              mimeType: 'application/pdf',
              filename: 'report.pdf'
            }
          ]
        }
      ];

      const payload = compat.buildPayload('gpt-4o', {}, messages as any, []);

      expect(payload.messages[0].content).toHaveLength(2);
      expect(payload.messages[0].content[0]).toEqual({ type: 'text', text: 'Review this document' });
      expect(payload.messages[0].content[1].type).toBe('file');
    });
  });

  describe('Google Gemini', () => {
    let compat: GoogleCompat;

    beforeEach(() => {
      compat = new GoogleCompat();
      // Set dummy API key
      process.env.GOOGLE_API_KEY = 'test-google-key';
    });

    afterEach(() => {
      delete process.env.GOOGLE_API_KEY;
    });

    it('should serialize base64 document content with inlineData format', async () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: 'dGVzdA==' },
              mimeType: 'application/pdf'
            }
          ]
        }
      ];

      // Mock the getSDKClient method to return a mock client
      const mockGenerateContent = jest.fn().mockResolvedValue({
        response: {
          text: () => 'Test response',
          candidates: [{
            content: {
              parts: [{ text: 'Test response' }]
            },
            finishReason: 'STOP'
          }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5
          }
        }
      });

      const getSDKClientSpy = jest.spyOn(compat as any, 'getSDKClient').mockReturnValue({
        models: {
          generateContent: mockGenerateContent
        }
      });

      await compat.callSDK('gemini-pro', {}, messages as any, []);

      expect(mockGenerateContent).toHaveBeenCalled();
      const callArgs = mockGenerateContent.mock.calls[0][0];

      expect(callArgs.contents[0].parts).toContainEqual({
        inlineData: {
          mimeType: 'application/pdf',
          data: 'dGVzdA=='
        }
      });

      getSDKClientSpy.mockRestore();
    });

    it('should serialize URL document content with fileData format', async () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'url', url: 'gs://bucket/doc.pdf' },
              mimeType: 'application/pdf'
            }
          ]
        }
      ];

      const mockGenerateContent = jest.fn().mockResolvedValue({
        response: {
          text: () => 'Test response',
          candidates: [{
            content: {
              parts: [{ text: 'Test response' }]
            },
            finishReason: 'STOP'
          }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5
          }
        }
      });

      const getSDKClientSpy = jest.spyOn(compat as any, 'getSDKClient').mockReturnValue({
        models: {
          generateContent: mockGenerateContent
        }
      });

      await compat.callSDK('gemini-pro', {}, messages as any, []);

      const callArgs = mockGenerateContent.mock.calls[0][0];

      expect(callArgs.contents[0].parts).toContainEqual({
        fileData: {
          fileUri: 'gs://bucket/doc.pdf',
          mimeType: 'application/pdf'
        }
      });

      getSDKClientSpy.mockRestore();
    });

    it('should serialize file_id document content with fileData format', async () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'file_id', fileId: 'gs://bucket/uploaded.pdf' },
              mimeType: 'application/pdf'
            }
          ]
        }
      ];

      const mockGenerateContent = jest.fn().mockResolvedValue({
        response: {
          text: () => 'Test response',
          candidates: [{
            content: {
              parts: [{ text: 'Test response' }]
            },
            finishReason: 'STOP'
          }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5
          }
        }
      });

      const getSDKClientSpy = jest.spyOn(compat as any, 'getSDKClient').mockReturnValue({
        models: {
          generateContent: mockGenerateContent
        }
      });

      await compat.callSDK('gemini-pro', {}, messages as any, []);

      const callArgs = mockGenerateContent.mock.calls[0][0];

      expect(callArgs.contents[0].parts).toContainEqual({
        fileData: {
          fileUri: 'gs://bucket/uploaded.pdf',
          mimeType: 'application/pdf'
        }
      });

      getSDKClientSpy.mockRestore();
    });
  });

  describe('OpenAI Responses API', () => {
    let compat: OpenAIResponsesCompat;

    beforeEach(() => {
      compat = new OpenAIResponsesCompat();
      // Set dummy API key
      process.env.OPENAI_API_KEY = 'test-openai-key';
    });

    afterEach(() => {
      delete process.env.OPENAI_API_KEY;
    });

    it('should serialize base64 document content with data URL prefix', async () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: 'dGVzdA==' },
              mimeType: 'application/pdf',
              filename: 'test.pdf'
            }
          ]
        }
      ];

      const mockCreate = jest.fn().mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: {
            role: 'assistant',
            content: 'Test response'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      });

      const getSDKClientSpy = jest.spyOn(compat as any, 'getSDKClient').mockReturnValue({
        responses: {
          create: mockCreate
        }
      });

      await compat.callSDK('gpt-4o', {}, messages as any, []);

      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0][0];

      expect(callArgs.input[0].content).toContainEqual({
        type: 'input_file',
        filename: 'test.pdf',
        file_data: 'data:application/pdf;base64,dGVzdA=='
      });

      getSDKClientSpy.mockRestore();
    });

    it('should use default filename if not provided for base64', async () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: 'dGVzdA==' },
              mimeType: 'application/pdf'
              // No filename provided
            }
          ]
        }
      ];

      const mockCreate = jest.fn().mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: {
            role: 'assistant',
            content: 'Test response'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      });

      const getSDKClientSpy = jest.spyOn(compat as any, 'getSDKClient').mockReturnValue({
        responses: {
          create: mockCreate
        }
      });

      await compat.callSDK('gpt-4o', {}, messages as any, []);

      const callArgs = mockCreate.mock.calls[0][0];

      expect(callArgs.input[0].content).toContainEqual({
        type: 'input_file',
        filename: 'document',
        file_data: 'data:application/pdf;base64,dGVzdA=='
      });

      getSDKClientSpy.mockRestore();
    });

    it('should serialize URL document content (supported in Responses API)', async () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'url', url: 'https://example.com/doc.pdf' },
              mimeType: 'application/pdf',
              filename: 'doc.pdf'
            }
          ]
        }
      ];

      const mockCreate = jest.fn().mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: {
            role: 'assistant',
            content: 'Test response'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      });

      const getSDKClientSpy = jest.spyOn(compat as any, 'getSDKClient').mockReturnValue({
        responses: {
          create: mockCreate
        }
      });

      await compat.callSDK('gpt-4o', {}, messages as any, []);

      const callArgs = mockCreate.mock.calls[0][0];

      expect(callArgs.input[0].content).toContainEqual({
        type: 'input_file',
        filename: 'doc.pdf',
        file_data: 'https://example.com/doc.pdf'
      });

      getSDKClientSpy.mockRestore();
    });

    it('should use default filename if not provided for URL', async () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'url', url: 'https://example.com/doc.pdf' },
              mimeType: 'application/pdf'
              // No filename provided
            }
          ]
        }
      ];

      const mockCreate = jest.fn().mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: {
            role: 'assistant',
            content: 'Test response'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      });

      const getSDKClientSpy = jest.spyOn(compat as any, 'getSDKClient').mockReturnValue({
        responses: {
          create: mockCreate
        }
      });

      await compat.callSDK('gpt-4o', {}, messages as any, []);

      const callArgs = mockCreate.mock.calls[0][0];

      expect(callArgs.input[0].content).toContainEqual({
        type: 'input_file',
        filename: 'document',
        file_data: 'https://example.com/doc.pdf'
      });

      getSDKClientSpy.mockRestore();
    });

    it('should serialize file_id document content', async () => {
      const messages: any[] = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document',
              source: { type: 'file_id', fileId: 'file-abc123' },
              mimeType: 'application/pdf'
            }
          ]
        }
      ];

      const mockCreate = jest.fn().mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: {
            role: 'assistant',
            content: 'Test response'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      });

      const getSDKClientSpy = jest.spyOn(compat as any, 'getSDKClient').mockReturnValue({
        responses: {
          create: mockCreate
        }
      });

      await compat.callSDK('gpt-4o', {}, messages as any, []);

      const callArgs = mockCreate.mock.calls[0][0];

      expect(callArgs.input[0].content).toContainEqual({
        type: 'input_file',
        file_id: 'file-abc123'
      });

      getSDKClientSpy.mockRestore();
    });
  });
});
