# Browser WebRTC example (OpenAI)

This is a **provider-specific** browser example that:
- calls the adapter server to mint a **short-lived client secret**
- uses that client secret to establish a **WebRTC** realtime session from the browser (no long-lived provider keys in the client)
- streams microphone audio in, plays assistant audio out, and prints **live transcripts**
- demonstrates **barge-in** by cancelling the assistant response when the provider reports user speech start

> All provider references are intentionally kept inside `/plugins`.

## Prerequisites
- Node.js 20+
- A working `OPENAI_API_KEY` in your environment (used **only** by the adapter server)

## Run it

From the repo root:

1) Install + build:
```bash
npm install
npm run build
```

2) Export your provider key (server-side only):
```bash
export OPENAI_API_KEY="..."
```

3) Start the dev helper:
```bash
node plugins/realtime-compat/openai/examples/browser/dev-server.js
```

4) Open the printed URL (default `http://127.0.0.1:8000`) and paste the printed adapter auth token.

5) Click **Connect** and allow microphone access.

## What to expect
- **User transcript** should appear as you speak (draft + final).
- **Assistant transcript** should appear as the assistant speaks.
- **Remote audio** should play through the `<audio>` element.
- **Barge-in**: speak while the assistant is speaking; the event log should show:
  - `input_audio_buffer.speech_started`
  - a `response.cancel` being sent

## Security notes
- Never put long-lived provider keys in the browser.
- This example uses the adapter server endpoint `POST /realtime/webrtc/client-secret` which requires server auth.
- The dev helper enables CORS **only** for the example origin.

## Troubleshooting

### 401 / Unauthorized when minting client secret
- Make sure you pasted the adapter auth token printed by `dev-server.js`.
- Ensure the adapter server is running and reachable at the URL you entered.

### Microphone permission errors
- Browsers require a secure context for mic access.
  - `http://localhost` / `http://127.0.0.1` is allowed
  - file:// is not
- Check OS-level mic permissions for your browser.

### No audio playback
- Confirm the browser tab is allowed to autoplay audio (the Connect click is a user gesture, but some setups still require explicit play).
- Verify you see a “remote audio track attached” log line.

### CORS errors
- This example expects the adapter server to allow requests from the static origin (default `http://127.0.0.1:8000`).
- If you change ports/host, restart the helper with matching env vars:
  - `REALTIME_WEBRTC_EXAMPLE_PORT`
  - `REALTIME_WEBRTC_ADAPTER_PORT`
  - `REALTIME_WEBRTC_HOST`

