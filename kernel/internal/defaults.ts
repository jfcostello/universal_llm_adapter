import * as fs from 'fs';
import * as path from 'path';
import { loadJsonFile } from './config.js';
import type { DefaultSettings } from './types.js';
import { PACKAGE_ROOT } from './paths.js';

/**
 * Inline fallback defaults used when JSON file is not found or invalid.
 * These values match the defaults.json file and serve as a safety net.
 */
const FALLBACK_DEFAULTS: DefaultSettings = {
  retry: {
    maxAttempts: 3,
    baseDelayMs: 250,
    multiplier: 2.0,
    rateLimitDelays: [1, 1, 5, 5, 5, 15, 15, 16, 30, 31, 61, 5, 5, 51]
  },
  tools: {
    countdownEnabled: true,
    finalPromptEnabled: true,
    parallelExecution: false,
    preserveResults: 3,
    preserveReasoning: 3,
    maxIterations: 10,
    timeoutMs: 120000
  },
  usageCost: false,
  vector: {
    topK: 5,
    injectTemplate: 'Relevant context:\n{{results}}',
    resultFormat: '- {{payload.text}} (score: {{score}})',
    batchSize: 10,
    includePayload: true,
    includeVector: false,
    defaultCollection: 'default',
    queryConstruction: {
      includeAssistantMessages: true,
      messagesToInclude: 1
    }
  },
  chunking: {
    size: 500,
    overlap: 50
  },
  tokenEstimation: {
    textDivisor: 4,
    imageEstimate: 768,
    toolResultDivisor: 6
  },
  timeouts: {
    mcpRequest: 30000,
    llmHttp: 60000,
    embeddingHttp: 60000,
    loggerFlush: 2000
  },
  server: {
    maxRequestBytes: 25 * 1024 * 1024,
    bodyReadTimeoutMs: 10000,
    requestTimeoutMs: 0,
    streamIdleTimeoutMs: 60000,
    maxConcurrentRequests: 128,
    maxConcurrentStreams: 32,
    maxQueueSize: 1000,
    queueTimeoutMs: 30000,
    maxConcurrentVectorRequests: 128,
    maxConcurrentVectorStreams: 32,
    vectorMaxQueueSize: 1000,
    vectorQueueTimeoutMs: 30000,
    maxConcurrentEmbeddingRequests: 128,
    embeddingMaxQueueSize: 1000,
    embeddingQueueTimeoutMs: 30000,
    auth: {
      enabled: false,
      allowBearer: true,
      allowApiKeyHeader: true,
      headerName: 'x-api-key',
      apiKeys: [],
      hashedKeys: [],
      realm: 'llm-adapter'
    },
    rateLimit: {
      enabled: false,
      requestsPerMinute: 120,
      burst: 30,
      trustProxyHeaders: false
    },
    cors: {
      enabled: false,
      allowedOrigins: [],
      allowedHeaders: ['content-type', 'authorization', 'x-api-key'],
      allowCredentials: false
    },
    securityHeadersEnabled: true,
    extensions: {
      enabled: [],
      voice: {
        events: {
          keepAliveIntervalMs: 15000
        },
        mediaWs: {
          tokenFromMessageTimeoutMs: 5000
        }
      }
    }
  },
  paths: {
    plugins: './plugins'
  },
  observability: {
    enabled: false,
    flushAt: 10,
    flushIntervalMs: 5000,
    maxQueueSize: 1000,
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 30000,
    timeoutMs: 10000,
    shutdownTimeoutMs: 5000,
    maxAttributeValueBytes: 16384,
    captureMessages: 'none',
    captureToolArgs: false,
    captureRequestPayload: false,
    captureRawResponse: false,
    sampleRate: 1,
    maxInputTextBytes: 4096,
    maxOutputTextBytes: 4096,
    maxJsonBytes: 8192
  }
};

let cachedDefaults: DefaultSettings | null = null;

/**
 * Get the default settings, loading from JSON file if available.
 * Results are cached after first load for performance.
 *
 * Search order:
 * 1. Relative to core module: ../plugins/configs/defaults.json
 * 2. Relative to cwd: ./plugins/configs/defaults.json
 * 3. Fallback to inline defaults
 */
export function getDefaults(): DefaultSettings {
  if (cachedDefaults) {
    return cachedDefaults;
  }

  const configPaths = [
    path.resolve(PACKAGE_ROOT, 'plugins', 'configs', 'defaults.json'),
    path.resolve(process.cwd(), 'plugins', 'configs', 'defaults.json')
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        cachedDefaults = loadJsonFile(configPath) as DefaultSettings;
        return cachedDefaults;
      } catch {
        // Continue to next path or fallback
      }
    }
  }

  cachedDefaults = { ...FALLBACK_DEFAULTS };
  return cachedDefaults;
}

/**
 * Clear the cached defaults. Primarily used for testing.
 */
export function resetDefaultsCache(): void {
  cachedDefaults = null;
}
