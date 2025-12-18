# `plugins/realtime-compat/openai`

OpenAI realtime compat implementation for the provider-agnostic realtime session API (`llm-adapter/realtime`).

## What this is
- This module implements the **realtime compat interface** (`IRealtimeCompat`) for the OpenAI realtime protocol.
- It is loaded lazily via `PluginRegistry.getRealtimeCompat('openai')`.
- It must not be imported by core code directly.

## Configuration
Configure a realtime provider manifest at `plugins/realtime-providers/openai.json`:

```json
{
  "id": "openai",
  "compat": "openai",
  "endpoint": {
    "urlTemplate": "wss://api.openai.com/v1/realtime?model={model}",
    "headers": {
      "Authorization": "Bearer ${OPENAI_API_KEY}"
    }
  },
  "webrtc": {
    "endpoint": {
      "urlTemplate": "https://api.openai.com/v1/realtime/calls",
      "headers": {
        "Content-Type": "application/sdp"
      }
    },
    "clientSecretEndpoint": {
      "urlTemplate": "https://api.openai.com/v1/realtime/client_secrets",
      "headers": {
        "Authorization": "Bearer ${OPENAI_API_KEY}",
        "Content-Type": "application/json"
      }
    }
  }
}
```

## Supported audio formats (codec/sample-rate terms only)
- `pcm16` @ **24000 Hz**, mono
- `g711_ulaw` @ **8000 Hz**, mono
- `g711_alaw` @ **8000 Hz**, mono

The compat validates these combinations before connecting.

## Normalized events emitted

This compat maps provider realtime events into the provider-agnostic `RealtimeEvent` taxonomy. Which events you receive depends on the session configuration and provider capabilities.

Common events include:
- `ready`
- `assistant_audio.chunk` / `assistant_audio.end`
- `assistant_transcript.delta` / `assistant_transcript.final`
- `user_transcript.delta` / `user_transcript.final` (when transcription is enabled)
- tool calling: `tool_call.*` (when tools are enabled)
- `usage`, `error`, `timeout`, `closed`

## Interrupt / barge-in

- `session.interrupt()` maps to provider cancellation.
- Core will emit `playback.clear_requested` when interruption/barge-in occurs; downstream transports should stop playback immediately.

## History injection

This compat supports seeding and injecting text-only history items via `conversation.item.create`.

- Startup seeding: provide `spec.history` when creating the session.
- Mid-session: call `session.injectContext(items)`.

Supported roles:
- `system` (text)
- `user` (text)
- `assistant` (text-only; no audio history injection)

## Usage (via `llm-adapter/realtime`)
```ts
import { PluginRegistry } from 'llm-adapter';
import { createRealtimeSession } from 'llm-adapter/realtime';

const registry = new PluginRegistry({ pluginsPath: './plugins' });

const session = await createRealtimeSession(registry, {
  provider: 'openai',
  model: 'gpt-realtime',
  transport: { type: 'ws' },
  systemPrompt: 'Be concise and helpful.',
  transcription: { enabled: true },
  bargeIn: { enabled: true, triggers: ['user_speech.started'] },
  turnDetection: { mode: 'manual_commit' },
  audio: {
    input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
    output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
  }
});

const eventsTask = (async () => {
  for await (const evt of session.events()) {
    // handle evt
  }
})();

await session.sendText({ role: 'user', text: 'Hello' });
await session.commit();

await session.close();
await eventsTask;
```

## WebRTC transport

When `spec.transport.type === 'webrtc'`, this compat connects using WebRTC SDP exchange + a data channel for JSON events.

Key points:
- You must provide `spec.webrtc.clientSecret` (short-lived client credential for WebRTC). Do not put long-lived API keys in browsers.
  - Use your own authenticated backend route to mint this (e.g., the bundled server route `POST /realtime/webrtc/client-secret`).
- Remote audio is delivered via the WebRTC media track. Provide `spec.webrtc.onRemoteStream(stream)` to attach it to playback.

Example (browser-style pseudocode):

```ts
const pcStream = await navigator.mediaDevices.getUserMedia({ audio: true });

const session = await createRealtimeSession(registry, {
  provider: 'openai',
  model: 'gpt-realtime',
  transport: { type: 'webrtc' },
  webrtc: {
    clientSecret: '<short-lived-secret>',
    inputStream: pcStream,
    onRemoteStream: (stream) => {
      // attach to an <audio> element, etc.
    }
  },
  transcription: { enabled: true }
});
```

## Notes / caveats
- `session.interrupt()` maps to provider cancellation. Audio/text alignment after cancellation is best-effort.
- Tool calling is supported via normalized `tool_call.*` events; tool results are injected back into the session by core.
