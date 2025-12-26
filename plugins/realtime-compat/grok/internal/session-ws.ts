import type { IRealtimeCompat, RealtimeCompatSession, RealtimeSessionSpec } from '../../../../kernel/index.js';

import { createWsTransport } from '../../../../modules/realtime/index.js';

import { createGrokRealtimeCompatSessionWithTransport } from './session-core.js';

function resolveRealtimeUrl(options: { urlTemplate: string; query?: Record<string, string> }): string {
  const url = new URL(String(options.urlTemplate));
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

export function createGrokRealtimeWsCompatSession(options: Parameters<IRealtimeCompat['createSession']>[0]): RealtimeCompatSession {
  const provider = options.provider;
  const spec = options.spec as RealtimeSessionSpec;

  const endpoint = provider.endpoint;
  if (!endpoint?.urlTemplate) {
    throw new Error(`Provider '${provider.id}' missing realtime endpoint configuration`);
  }

  // Grok Voice Agent API realtime endpoint does not currently use `{model}`.
  // `spec.model` is intentionally optional/ignored here.
  const url = resolveRealtimeUrl({ urlTemplate: endpoint.urlTemplate, query: endpoint.query });

  const headers = endpoint.headers ?? {};
  const transport = createWsTransport({ url, headers });
  return createGrokRealtimeCompatSessionWithTransport(options, transport as any);
}
