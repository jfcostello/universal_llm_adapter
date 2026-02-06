import AjvImport from 'ajv';

export function resolveAjvConstructor(mod: any) {
  return mod?.default ?? mod;
}

const Ajv = resolveAjvConstructor(AjvImport as any);
const ajv = new Ajv({ allErrors: true, strict: false });

const contentPartSchema: any = {
  anyOf: [
    {
      type: 'object',
      required: ['type', 'text'],
      properties: {
        type: { type: 'string', enum: ['text'] },
        text: { type: 'string' }
      },
      additionalProperties: true
    },
    {
      type: 'object',
      required: ['type', 'imageUrl'],
      properties: {
        type: { type: 'string', enum: ['image'] },
        imageUrl: { type: 'string' },
        mimeType: { type: 'string', nullable: true }
      },
      additionalProperties: true
    },
    {
      type: 'object',
      required: ['type', 'toolName', 'result'],
      properties: {
        type: { type: 'string', enum: ['tool_result'] },
        toolName: { type: 'string' },
        result: {}
      },
      additionalProperties: true
    },
    {
      type: 'object',
      required: ['type', 'source'],
      properties: {
        type: { type: 'string', enum: ['document'] },
        source: {
          anyOf: [
            {
              type: 'object',
              required: ['type', 'path'],
              properties: {
                type: { type: 'string', enum: ['filepath'] },
                path: { type: 'string' }
              },
              additionalProperties: true
            },
            {
              type: 'object',
              required: ['type', 'data'],
              properties: {
                type: { type: 'string', enum: ['base64'] },
                data: { type: 'string' }
              },
              additionalProperties: true
            },
            {
              type: 'object',
              required: ['type', 'url'],
              properties: {
                type: { type: 'string', enum: ['url'] },
                url: { type: 'string' }
              },
              additionalProperties: true
            },
            {
              type: 'object',
              required: ['type', 'fileId'],
              properties: {
                type: { type: 'string', enum: ['file_id'] },
                fileId: { type: 'string' }
              },
              additionalProperties: true
            }
          ]
        },
        mimeType: { type: 'string', nullable: true },
        filename: { type: 'string', nullable: true },
        providerOptions: { type: 'object', nullable: true, additionalProperties: true }
      },
      additionalProperties: true
    }
  ]
};

const llmSpecSchema: any = {
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
              ...contentPartSchema
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
        { type: 'string', enum: ['auto', 'none', 'required'] },
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

const validateLlm = ajv.compile(llmSpecSchema);

const vectorSpecSchema: any = {
  type: 'object',
  required: ['operation', 'store'],
  properties: {
    operation: { type: 'string' },
    store: { type: 'string' },
    collection: { type: 'string', nullable: true },
    embeddingPriority: {
      type: 'array',
      nullable: true,
      items: {
        type: 'object',
        required: ['provider'],
        properties: {
          provider: { type: 'string' },
          model: { type: 'string', nullable: true }
        },
        additionalProperties: true
      }
    },
    input: { type: 'object', nullable: true, additionalProperties: true },
    settings: { type: 'object', nullable: true, additionalProperties: true },
    metadata: { type: 'object', nullable: true, additionalProperties: true }
  },
  additionalProperties: true
};

const validateVector = ajv.compile(vectorSpecSchema);

const embeddingSpecSchema: any = {
  type: 'object',
  required: ['operation'],
  properties: {
    operation: { type: 'string' },
    provider: { type: 'string', nullable: true },
    model: { type: 'string', nullable: true },
    embeddingPriority: {
      type: 'array',
      nullable: true,
      items: {
        type: 'object',
        required: ['provider'],
        properties: {
          provider: { type: 'string' },
          model: { type: 'string', nullable: true }
        },
        additionalProperties: true
      }
    },
    input: { type: 'object', nullable: true, additionalProperties: true },
    metadata: { type: 'object', nullable: true, additionalProperties: true }
  },
  additionalProperties: true
};

const validateEmbedding = ajv.compile(embeddingSpecSchema);

const telemetrySignalSchema: any = {
  type: 'object',
  required: ['type', 'traceId', 'level', 'message'],
  properties: {
    type: { type: 'string', enum: ['signal'] },
    traceId: { type: 'string', minLength: 1, pattern: '\\S' },
    generationId: { type: 'string', nullable: true, pattern: '\\S' },
    timestampMs: { type: 'number', nullable: true },
    level: { type: 'string', enum: ['debug', 'info', 'warning', 'error'] },
    message: { type: 'string', minLength: 1, pattern: '\\S' },
    source: { type: 'string', nullable: true },
    code: { type: 'string', nullable: true },
    stack: { type: 'string', nullable: true },
    tags: { type: 'array', nullable: true, items: { type: 'string' } },
    metadata: { type: 'object', nullable: true, additionalProperties: true },
    observability: { type: 'object', nullable: true, additionalProperties: true }
  },
  additionalProperties: true
};

const telemetryTraceUpdateSchema: any = {
  type: 'object',
  required: ['type', 'traceId'],
  properties: {
    type: { type: 'string', enum: ['trace_update'] },
    traceId: { type: 'string', minLength: 1, pattern: '\\S' },
    generationId: { type: 'string', nullable: true, pattern: '\\S' },
    timestampMs: { type: 'number', nullable: true },
    name: { type: 'string', nullable: true },
    tags: { type: 'array', nullable: true, items: { type: 'string' } },
    metadata: { type: 'object', nullable: true, additionalProperties: true },
    observability: { type: 'object', nullable: true, additionalProperties: true }
  },
  additionalProperties: true
};

const telemetrySubmissionSchema: any = {
  anyOf: [telemetrySignalSchema, telemetryTraceUpdateSchema]
};

const validateTelemetrySubmission = ajv.compile(telemetrySubmissionSchema);

function normalizeObservabilityOverrideAllowlist(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  return new Set(normalized);
}

function createTelemetryValidationError(details: unknown): Error {
  const error = new Error('Telemetry validation failed');
  (error as any).statusCode = 400;
  (error as any).code = 'validation_error';
  (error as any).details = details;
  return error;
}

function assertTelemetryObservabilityOverridesAllowed(payload: unknown, allowlist: Set<string>): void {
  const observability = (payload as any)?.observability;
  if (!observability || typeof observability !== 'object' || Array.isArray(observability)) return;

  const disallowedKeys = Object.keys(observability).filter(key => !allowlist.has(key));
  if (disallowedKeys.length === 0) return;

  throw createTelemetryValidationError(
    disallowedKeys.map(key => ({
      path: `.observability.${key}`,
      message: `observability override key '${key}' is not allowed by server policy`
    }))
  );
}

export function assertValidSpec(spec: unknown): void {
  const ok = validateLlm(spec);
  if (ok) return;

  const error = new Error('Spec validation failed');
  (error as any).statusCode = 400;
  (error as any).code = 'validation_error';
  (error as any).details = validateLlm.errors;
  throw error;
}

export function assertValidVectorSpec(spec: unknown): void {
  const ok = validateVector(spec);
  if (ok) return;

  const error = new Error('Spec validation failed');
  (error as any).statusCode = 400;
  (error as any).code = 'validation_error';
  (error as any).details = validateVector.errors;
  throw error;
}

export function assertValidEmbeddingSpec(spec: unknown): void {
  const ok = validateEmbedding(spec);
  if (ok) return;

  const error = new Error('Spec validation failed');
  (error as any).statusCode = 400;
  (error as any).code = 'validation_error';
  (error as any).details = validateEmbedding.errors;
  throw error;
}

export function assertValidTelemetrySubmission(
  payload: unknown,
  options: { observabilityOverrideAllowlist?: string[] } = {}
): void {
  const ok = validateTelemetrySubmission(payload);
  if (!ok) {
    throw createTelemetryValidationError(validateTelemetrySubmission.errors);
  }

  const allowlist = normalizeObservabilityOverrideAllowlist(options.observabilityOverrideAllowlist);
  if (allowlist) {
    assertTelemetryObservabilityOverridesAllowed(payload, allowlist);
  }
}
