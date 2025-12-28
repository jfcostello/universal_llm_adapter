# Twilio inbound call bridge example

This is a runnable example server that:

- serves a TwiML endpoint (`/twiml`) that instructs Twilio to open a Media Stream
- accepts the Media Streams WebSocket connection (`/twilio/media`)
- bridges the call to a realtime session using `plugins/voice-modules/twilio-media-streams`

## Requirements

- Repo deps installed at the root (`npm install`)
- Built JS output available (`npm run build`) so this example can import from `dist/`

## Setup

1) Copy env template and fill in values:

```bash
cp .env.example .env
```

2) Build the repo:

```bash
cd ../../../../../
npm run build
```

3) Run the server:

```bash
node plugins/voice-modules/twilio-media-streams/examples/twilio-inbound/server.mjs
```

You should see the server URL printed.

## Configure Twilio

- Point your Voice webhook / TwiML URL at `https://YOUR_PUBLIC_HOST/twiml`.
- The `/twiml` handler returns TwiML that connects a Media Stream to `wss://YOUR_PUBLIC_HOST/twilio/media?token=...`.

The signed token is required; if it fails validation the bridge will immediately close the socket with code `1008`.

### Outbound calls

Outbound initiation is the consuming app’s responsibility. Once a call connects to your TwiML endpoint and Twilio opens the Media Stream, the bridge flow is identical.

## Notes

- This example intentionally avoids logging raw audio payloads.
- Call metadata is printed on `start`.
