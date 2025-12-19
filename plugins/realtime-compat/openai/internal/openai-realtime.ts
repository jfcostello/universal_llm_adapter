import type { IRealtimeCompat } from '../../../../modules/kernel/index.js';
import type { RealtimeSessionSpec } from '../../../../modules/kernel/index.js';

import { resolveOpenAIClientSecretUrl } from './session-core.js';

export default class OpenAIRealtimeCompat implements IRealtimeCompat {
  async createSession(options: Parameters<IRealtimeCompat['createSession']>[0]) {
    const spec = options.spec as RealtimeSessionSpec;
    const transportType = spec.transport?.type ?? 'ws';

    if (transportType === 'webrtc') {
      const { createOpenAIRealtimeWebrtcCompatSession } = await import('./session-webrtc.js');
      return createOpenAIRealtimeWebrtcCompatSession(options);
    }

    const { createOpenAIRealtimeWsCompatSession } = await import('./session-ws.js');
    return createOpenAIRealtimeWsCompatSession(options);
  }

  async mintClientSecret(options: Parameters<NonNullable<IRealtimeCompat['mintClientSecret']>>[0]) {
    const spec = options.spec as RealtimeSessionSpec;
    const url = resolveOpenAIClientSecretUrl({ provider: options.provider, spec });
    const headers = { ...(options.provider.webrtc?.clientSecretEndpoint?.headers ?? {}) } as Record<string, string>;
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const model = spec.model ?? (options.provider.metadata as any)?.defaultModel;
    if (!model) {
      throw new Error(`Realtime session requires 'model' for provider '${options.provider.id}'`);
    }

    const body: Record<string, unknown> = {
      model,
      modalities: ['audio', 'text'],
      ...(spec.systemPrompt ? { instructions: spec.systemPrompt } : {})
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Client secret mint request failed (${res.status}): ${text || res.statusText}`);
    }

    const payload = (await res.json()) as any;
    const value = String(payload?.client_secret?.value ?? '');
    if (!value) {
      throw new Error('Realtime client secret response missing client_secret.value');
    }

    const expiresAt = typeof payload?.client_secret?.expires_at === 'number'
      ? payload.client_secret.expires_at
      : undefined;
    return { clientSecret: value, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  }
}
