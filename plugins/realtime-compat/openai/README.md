# `plugins/realtime-compat/openai`

OpenAI realtime compat implementation for the provider-agnostic realtime session API (`llm-adapter/realtime`).

## What this is
- This module implements the **realtime compat interface** (`IRealtimeCompat`) for the OpenAI realtime protocol.
- It is loaded lazily via `PluginRegistry.getRealtimeCompat('openai')`.
- It must not be imported by core code directly.

## Configuration
Enable realtime for the provider by adding a `realtime` block to `plugins/providers/openai.json`:

```json
{
  "id": "openai",
  "realtime": {
    "compat": "openai",
    "endpoint": {
      "urlTemplate": "wss://api.openai.com/v1/realtime?model={model}",
      "headers": {
        "Authorization": "Bearer ${OPENAI_API_KEY}"
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

## Usage (via `llm-adapter/realtime`)
```ts
import { PluginRegistry } from 'llm-adapter';
import { createRealtimeSession } from 'llm-adapter/realtime';

const registry = new PluginRegistry({ pluginsPath: './plugins' });

const session = await createRealtimeSession(registry, {
  provider: 'openai',
  model: 'gpt-realtime',
  systemPrompt: 'Be concise and helpful.',
  transcription: { enabled: true },
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

## Notes / caveats
- `session.interrupt()` maps to provider cancellation. Audio/text alignment after cancellation is best-effort.
- Tool calling is supported via normalized `tool_call.*` events and `sendToolResult()`.

