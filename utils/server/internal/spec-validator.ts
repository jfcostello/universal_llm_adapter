import AjvImport from 'ajv';

export function resolveAjvConstructor(mod: any) {
  return mod?.default ?? mod;
}

const Ajv = resolveAjvConstructor(AjvImport as any);
const ajv = new Ajv({ allErrors: true, strict: false });

const specSchema: any = {
  type: 'object',
  required: ['messages', 'llmPriority', 'settings'],
  properties: {
    systemPrompt: { type: 'string', nullable: true },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'content'],
        properties: {
          role: { type: 'string' },
          content: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'string' }
              },
              additionalProperties: true
            }
          },
          name: { type: 'string', nullable: true },
          toolCalls: {
            anyOf: [
              { type: 'array', items: {} },
              { type: 'object', additionalProperties: true },
              { type: 'null' }
            ]
          },
          toolCallId: { type: 'string', nullable: true },
          metadata: { type: 'object', nullable: true, additionalProperties: true }
        },
        additionalProperties: true
      }
    },
    llmPriority: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['provider', 'model'],
        properties: {
          provider: { type: 'string' },
          model: { type: 'string' },
          settings: { type: 'object', nullable: true, additionalProperties: true }
        },
        additionalProperties: true
      }
    },
    functionToolNames: { type: 'array', items: { type: 'string' }, nullable: true },
    tools: { type: 'array', items: {}, nullable: true },
    mcpServers: { type: 'array', items: { type: 'string' }, nullable: true },
    vectorStores: { type: 'array', items: { type: 'string' }, nullable: true },
    vectorPriority: { type: 'array', items: { type: 'string' }, nullable: true },
    vectorContext: { type: 'object', nullable: true, additionalProperties: true },
    toolChoice: {
      anyOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' }
      ]
    },
    rateLimitRetryDelays: { type: 'array', items: { type: 'number' }, nullable: true },
    settings: { type: 'object', additionalProperties: true },
    metadata: { type: 'object', nullable: true, additionalProperties: true }
  },
  additionalProperties: true
};

const validate = ajv.compile(specSchema);

export function assertValidSpec(spec: unknown): void {
  const ok = validate(spec);
  if (ok) return;

  const error = new Error('Spec validation failed');
  (error as any).statusCode = 400;
  (error as any).code = 'validation_error';
  (error as any).details = validate.errors;
  throw error;
}
