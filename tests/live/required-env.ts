import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedDefaultsObservabilityProviders: string[] | null | undefined;

function readDefaultsObservabilityProviders(): string[] {
  if (cachedDefaultsObservabilityProviders !== undefined) {
    return cachedDefaultsObservabilityProviders ?? [];
  }

  const defaultsPath = path.join(__dirname, '..', '..', 'plugins', 'configs', 'defaults.json');
  try {
    if (!fs.existsSync(defaultsPath)) {
      cachedDefaultsObservabilityProviders = ['langfuse'];
      return cachedDefaultsObservabilityProviders;
    }

    const raw = fs.readFileSync(defaultsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const obs = parsed?.observability;

    const providers = new Set<string>();
    const single = obs?.provider;
    if (typeof single === 'string' && single.trim() !== '') {
      providers.add(single.trim());
    }

    const targets = Array.isArray(obs?.targets) ? obs.targets : [];
    for (const target of targets) {
      const provider = target?.provider;
      if (typeof provider === 'string' && provider.trim() !== '') {
        providers.add(provider.trim());
      }
    }

    if (providers.size === 0) {
      providers.add('langfuse');
    }

    const list = [...providers];
    cachedDefaultsObservabilityProviders = list;
    return list;
  } catch {
    cachedDefaultsObservabilityProviders = ['langfuse'];
    return cachedDefaultsObservabilityProviders;
  }
}

function isRealtimePattern(raw: string): boolean {
  // Provider-specific runs exclude realtime via a negative lookahead, but the literal
  // string "realtime" still appears in the pattern. Treat those as non-realtime.
  if (/\(\?!.*realtime/i.test(raw)) return false;
  return /\brealtime\b/i.test(raw);
}

export function getTestPathPatternsFromJestArgs(jestArgs: string[]): string[] {
  const patterns: string[] = [];

  for (let i = 0; i < jestArgs.length; i++) {
    const arg = jestArgs[i];
    if (arg.startsWith('--testPathPattern=')) {
      patterns.push(arg.slice('--testPathPattern='.length));
      continue;
    }

    if (arg === '--testPathPattern') {
      const next = jestArgs[i + 1];
      if (next) patterns.push(String(next));
      i++;
    }
  }

  return patterns.map(p => String(p || '').trim()).filter(Boolean);
}

export function getMissingRequiredEnv(options: {
  selectedProviders: string[];
  testPathPatterns: string[];
  env: NodeJS.ProcessEnv;
}): string[] {
  const required = new Set<string>();

  const requiredByProvider: Record<string, string[]> = {
    anthropic: ['ANTHROPIC_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    'openai-responses': ['OPENAI_API_KEY'],
    'openai-assistants': ['OPENAI_API_KEY', 'OPENAI_ASSISTANTS_ASSISTANT_ID'],
    'azure-openai-assistants': ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'OPENAI_API_VERSION'],
    openrouter: ['OPENROUTER_API_KEY'],
    google: ['GEMINI_API_KEY'],
    grok: ['XAI_API_KEY'],
    vapi: ['VAPI_API_KEY']
  };

  for (const provider of options.selectedProviders) {
    for (const key of requiredByProvider[String(provider)] ?? []) {
      required.add(key);
    }
  }

  const patterns = options.testPathPatterns.join(' ');
  const wantsAllLive = /\blive\b/i.test(patterns);
  const wantsEmbeddings = /\bembeddings\b|15-embeddings/i.test(patterns);
  const wantsVector =
    /\bvector\b|16-vector-store|17-vector-cli|18-vector-auto-inject|19-vector-search-locks/i.test(patterns);
  const wantsRealtimeOnly = options.testPathPatterns.length > 0 && options.testPathPatterns.every((p) => {
    const raw = String(p);
    return isRealtimePattern(raw);
  });
  const wantsEmbeddingsOnly = options.testPathPatterns.length > 0 && options.testPathPatterns.every((p) => {
    const raw = String(p);
    return /\bembeddings\b|15-embeddings/i.test(raw);
  });
  const wantsVectorNonLlmOnly = options.testPathPatterns.length > 0 && options.testPathPatterns.every((p) => {
    const raw = String(p);
    return /16-vector-store|17-vector-cli/i.test(raw);
  });
  const expectsLlmCalls = !wantsRealtimeOnly && !wantsEmbeddingsOnly && !wantsVectorNonLlmOnly;

  // Live suite includes embeddings/vector coverage; these are required for a full pass.
  if (wantsAllLive || wantsEmbeddings || wantsVector) {
    required.add('OPENROUTER_API_KEY');
  }
  if (wantsAllLive || wantsVector) {
    required.add('QDRANT_CLOUD_URL');
    required.add('QDRANT_API_KEY');
  }

  // Require Langfuse auth when the configured observability provider is langfuse and
  // the selected live suite is expected to include LLM calls.
  const observabilityProviders = readDefaultsObservabilityProviders();
  if (expectsLlmCalls && observabilityProviders.includes('langfuse')) {
    required.add('LANGFUSE_PUBLIC_KEY');
    required.add('LANGFUSE_SECRET_KEY');
  }

  return [...required].filter(key => !options.env?.[key] || String(options.env[key]).trim() === '');
}
