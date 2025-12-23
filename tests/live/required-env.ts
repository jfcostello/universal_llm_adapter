import { observabilityTestProvider } from './config.ts';

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
    openrouter: ['OPENROUTER_API_KEY'],
    google: ['GEMINI_API_KEY'],
    grok: ['XAI_API_KEY']
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

  // Live suite includes embeddings/vector coverage; these are required for a full pass.
  if (wantsAllLive || wantsEmbeddings || wantsVector) {
    required.add('OPENROUTER_API_KEY');
  }
  if (wantsAllLive || wantsVector) {
    required.add('QDRANT_CLOUD_URL');
    required.add('QDRANT_API_KEY');
  }

  // Observability tests require Langfuse keys only when:
  // 1) observabilityTestProvider is configured in config.ts, AND
  // 2) the test pattern explicitly includes observability tests
  const wantsObservability = /\bobservability\b|21-observability/i.test(patterns);
  if (wantsObservability && observabilityTestProvider !== null) {
    required.add('LANGFUSE_SECRET_KEY');
    required.add('LANGFUSE_PUBLIC_KEY');
  }

  return [...required].filter(key => !options.env?.[key] || String(options.env[key]).trim() === '');
}
