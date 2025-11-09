import { Role, Message, UnifiedTool } from '../../../core/types.js';

/**
 * Shared test fixtures for provider integration tests
 * These fixtures provide reusable test data across all provider tests
 */

// Basic messages for simple tests
export const baseMessages: Message[] = [
  { role: Role.SYSTEM, content: [{ type: 'text', text: 'system' }] },
  { role: Role.USER, content: [{ type: 'text', text: 'hello' }] }
];

// Basic tools for function calling tests
export const baseTools: UnifiedTool[] = [
  {
    name: 'echo.text',
    description: 'Echo tool',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' }
      },
      required: ['text']
    }
  }
];

// Multiple tools for testing
export const multipleTools: UnifiedTool[] = [
  {
    name: 'get.weather',
    description: 'Get weather information',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        units: { type: 'string', enum: ['celsius', 'fahrenheit'] }
      },
      required: ['city']
    }
  },
  {
    name: 'search.web',
    description: 'Search the web',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: ['query']
    }
  }
];

// Messages with images
export const imageMessages: Message[] = [
  {
    role: Role.USER,
    content: [
      { type: 'text', text: 'What is this?' },
      { type: 'image', imageUrl: 'https://example.com/image.jpg', mimeType: 'image/jpeg' }
    ]
  }
];

// Messages with tool calls
export const toolCallMessages: Message[] = [
  {
    role: Role.ASSISTANT,
    content: [],
    toolCalls: [{ id: 'call-1', name: 'get.weather', arguments: { city: 'SF' } }]
  }
];

// Messages with tool results
export const toolResultMessages: Message[] = [
  {
    role: Role.TOOL,
    toolCallId: 'call-1',
    content: [
      { type: 'tool_result', toolName: 'get.weather', result: { temp: 72 } },
      { type: 'text', text: 'Temperature is 72°F' }
    ]
  }
];

// Messages with reasoning
export const reasoningMessages: Message[] = [
  {
    role: Role.ASSISTANT,
    content: [{ type: 'text', text: 'The answer is 42.' }],
    reasoning: {
      text: 'Let me think about this step by step...',
      metadata: { stage: 'analysis' }
    }
  }
];

// Messages with reasoning and signature (Anthropic)
export const reasoningWithSignatureMessages: Message[] = [
  {
    role: Role.ASSISTANT,
    content: [{ type: 'text', text: 'Final answer.' }],
    reasoning: {
      text: 'Deep thinking...',
      metadata: { signature: 'abc123xyz' }
    }
  }
];

// Complex multi-turn conversation
export const complexConversation: Message[] = [
  { role: Role.SYSTEM, content: [{ type: 'text', text: 'You are helpful' }] },
  { role: Role.USER, content: [{ type: 'text', text: 'Get weather for NYC' }] },
  {
    role: Role.ASSISTANT,
    content: [],
    toolCalls: [{ id: 'call-1', name: 'get.weather', arguments: { city: 'NYC' } }]
  },
  {
    role: Role.TOOL,
    toolCallId: 'call-1',
    content: [
      { type: 'tool_result', toolName: 'get.weather', result: { temp: 65, condition: 'sunny' } },
      { type: 'text', text: 'Temperature: 65°F, Condition: sunny' }
    ]
  },
  {
    role: Role.ASSISTANT,
    content: [{ type: 'text', text: 'The weather in NYC is sunny and 65°F.' }]
  }
];

// Messages with multiple tool calls
export const multipleToolCallMessages: Message[] = [
  {
    role: Role.ASSISTANT,
    content: [],
    toolCalls: [
      { id: 'call-1', name: 'get.weather', arguments: { city: 'NYC' } },
      { id: 'call-2', name: 'get.weather', arguments: { city: 'LA' } }
    ]
  }
];

// Empty content messages
export const emptyContentMessages: Message[] = [
  { role: Role.ASSISTANT, content: [] }
];

// Messages with name field
export const namedMessages: Message[] = [
  {
    role: Role.USER,
    content: [{ type: 'text', text: 'Hello' }],
    name: 'user.name-123'
  }
];

// Messages with invalid characters in name (for sanitization)
export const invalidNameMessages: Message[] = [
  {
    role: Role.USER,
    content: [{ type: 'text', text: 'Hello' }],
    name: 'user@email.com'
  }
];

// Multiple system messages
export const multipleSystemMessages: Message[] = [
  { role: Role.SYSTEM, content: [{ type: 'text', text: 'Part 1. ' }] },
  { role: Role.SYSTEM, content: [{ type: 'text', text: 'Part 2.' }] },
  { role: Role.USER, content: [{ type: 'text', text: 'Hello' }] }
];

// Pending tool results at end
export const pendingToolResultMessages: Message[] = [
  { role: Role.USER, content: [{ type: 'text', text: 'Call tool' }] },
  {
    role: Role.ASSISTANT,
    content: [],
    toolCalls: [{ id: 'call-1', name: 'echo.text', arguments: { text: 'hi' } }]
  },
  {
    role: Role.TOOL,
    toolCallId: 'call-1',
    content: [
      { type: 'tool_result', toolName: 'echo.text', result: 'hi' },
      { type: 'text', text: 'hi' }
    ]
  }
];

// All settings for comprehensive testing
export const allSettings = {
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 1024,
  stop: ['STOP', 'END'],
  responseFormat: 'json_object',
  seed: 42,
  frequencyPenalty: 0.5,
  presencePenalty: 0.3,
  logitBias: { 123: -100 },
  logprobs: true,
  topLogprobs: 5,
  reasoning: { enabled: true, budget: 2048 }
};

// Minimal settings
export const minimalSettings = {
  temperature: 0
};

// Reasoning settings
export const reasoningSettings = {
  temperature: 0.7,
  reasoning: { enabled: true, budget: 4096 }
};
