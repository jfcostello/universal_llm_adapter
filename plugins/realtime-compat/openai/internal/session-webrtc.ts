import type { IRealtimeCompat, RealtimeCompatSession, RealtimeSessionSpec } from '../../../../kernel/index.js';

import { createOpenAIRealtimeCompatSessionWithTransport, resolveOpenAIWebrtcSdpUrl } from './session-core.js';
import { createWebrtcTransport } from './transport/webrtc.js';

const DEFAULT_DATA_CHANNEL_LABEL = 'oai-events';

export function createOpenAIRealtimeWebrtcCompatSession(
  options: Parameters<IRealtimeCompat['createSession']>[0]
): RealtimeCompatSession {
  const provider = options.provider;
  const spec = options.spec as RealtimeSessionSpec;

  const clientSecret = spec.webrtc?.clientSecret;
  if (!clientSecret) {
    throw new Error('WebRTC transport requires spec.webrtc.clientSecret');
  }

  const url = resolveOpenAIWebrtcSdpUrl({ provider, spec });
  const headers = provider.webrtc?.endpoint?.headers ?? {};

  const dataChannelLabel = spec.webrtc?.dataChannelLabel ?? DEFAULT_DATA_CHANNEL_LABEL;
  const { transport } = createWebrtcTransport({
    url,
    clientSecret,
    dataChannelLabel,
    headers,
    inputStream: spec.webrtc?.inputStream,
    onRemoteStream: spec.webrtc?.onRemoteStream
  });

  return createOpenAIRealtimeCompatSessionWithTransport(options, transport);
}
