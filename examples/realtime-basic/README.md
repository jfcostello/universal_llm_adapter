# `examples/realtime-basic`

Minimal provider-agnostic realtime session example.

This example demonstrates:
- creating a realtime session
- streaming audio frames (optional)
- sending text + committing turns
- printing normalized realtime events safely (no raw audio payloads)
- enabling tool calling via `functionToolNames`

## Prerequisites

- Configure `./plugins` for your environment (realtime provider manifests + realtime compat configuration).
- Set whatever environment variables your configured plugins require (API keys, etc.).

## Environment variables

Required:

- `REALTIME_PROVIDER_ID` — realtime provider id from `plugins/realtime-providers/*.json`

Optional:

- `REALTIME_MODEL` — provider-specific model string (if applicable)
- `REALTIME_SYSTEM_PROMPT` — system prompt
- `REALTIME_TEXT` — the user text to send (defaults to a tool-call prompting message)
- `REALTIME_TRANSCRIPTION=1` — enable user transcription

Audio (optional):

- `REALTIME_AUDIO_PATH` — path to a raw audio file to stream in
- `REALTIME_AUDIO_FORMAT` — `pcm16` | `g711_ulaw` | `g711_alaw` (default: `pcm16`)
- `REALTIME_AUDIO_SAMPLE_RATE_HZ` — number (default: `24000`)
- `REALTIME_AUDIO_CHANNELS` — `1` or `2` (default: `1`)
- `REALTIME_AUDIO_FRAME_MS` — frame size in ms (default: `20`)
- `REALTIME_AUDIO_PACE=0` — disable real-time pacing (sends as fast as possible)

## Run

From repo root:

```bash
npx tsx examples/realtime-basic/run.ts
```
