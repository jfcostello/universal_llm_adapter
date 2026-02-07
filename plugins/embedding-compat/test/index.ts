import type {
  EmbeddingCompatOptions,
  EmbeddingProviderConfig,
  EmbeddingResult,
  IEmbeddingCompat,
  IEmbeddingOperationLogger
} from '../../../kernel/index.js';

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function embedText(text: string, dimensions: number): number[] {
  const vector = new Array(dimensions).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const idx = hashToken(token) % dimensions;
    vector[idx] += 1;
  }

  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i] / norm;
    }
  }

  return vector;
}

export default class TestEmbeddingCompat implements IEmbeddingCompat {
  async embed(
    input: string | string[],
    config: EmbeddingProviderConfig,
    model?: string,
    logger?: IEmbeddingOperationLogger,
    options?: EmbeddingCompatOptions
  ): Promise<EmbeddingResult> {
    if (options?.signal?.aborted) {
      throw new Error('Embedding request aborted');
    }

    const dimensions = this.getDimensions(config, model);
    const texts = Array.isArray(input) ? input : [input];

    logger?.logEmbeddingRequest({
      url: config.endpoint.urlTemplate,
      method: 'POST',
      headers: config.endpoint.headers,
      body: { input: texts },
      provider: config.kind,
      model: model || config.model
    });

    const vectors = texts.map(text => embedText(text, dimensions));
    const tokenCount = texts.reduce((acc, text) => acc + tokenize(text).length, 0);

    const result: EmbeddingResult = {
      vectors,
      model: model || config.model,
      dimensions,
      tokenCount
    };

    logger?.logEmbeddingResponse({
      status: 200,
      headers: {},
      body: { vectors: vectors.length },
      dimensions: result.dimensions,
      tokenCount: result.tokenCount
    });

    return result;
  }

  getDimensions(config: EmbeddingProviderConfig, _model?: string): number {
    return config.dimensions ?? 64;
  }

  async validate(config: EmbeddingProviderConfig): Promise<boolean> {
    return this.getDimensions(config) > 0;
  }
}
