# `plugins/voice-modules/twilio-media-streams`

Bridge a Twilio Media Streams WebSocket connection to a `llm-adapter/realtime` session.

## What this module does

- Accepts a Twilio Media Streams WebSocket (`connected` / `start` / `media` / `mark` / `dtmf` / `stop`)
- Creates a realtime session (via an injected `createSession()` callback)
- Forwards inbound caller audio → realtime session audio input
- Forwards assistant audio chunks → Twilio outbound `media` messages (framed, paced, and encoded as g711_ulaw@8kHz mono)
- Implements telephony-friendly interruption behavior by honoring normalized realtime playback control events
- Surfaces call metadata + mark + DTMF + raw realtime events via callbacks

This code is Twilio-specific, so it lives under `/plugins` by design.

---

## Public API

Exported from `plugins/voice-modules/twilio-media-streams/index.ts`:

- `createTwilioMediaStreamsBridge(options)`
- Types:
  - `TwilioMediaStreamsBridgeOptions`
  - `TwilioMediaStreamsBridgeSecurity`
  - `TwilioMediaStreamsBridgeLimits`
  - `TwilioMediaStreamsBridgeAudioOptions`
  - `TwilioMediaStreamsBridgeCallbacks`
  - `TwilioCallMetadata`

### `createTwilioMediaStreamsBridge(options)`

```ts
const bridge = createTwilioMediaStreamsBridge({
  createSession: async ({ metadata }) => /* return a RealtimeSession */,
  security: {
    tokenSecret: process.env.TWILIO_STREAM_TOKEN_SECRET!,
    tokenParam: 'token',
    tokenMaxTtlSeconds: 300,
    tokenClockSkewSeconds: 5,
    allowedAccountSids: []
  },
  limits: {
    maxWsMessageBytes: 262144,
    maxAudioBytesPerSecond: 256000,
    idleTimeoutMs: 60000,
    maxSessionDurationMs: 3600000,
    startTimeoutMs: 5000,
    maxPendingInboundFrames: 200,
    maxPendingOutboundAudioMs: 10000
  },
  audio: {
    frameMs: 20,
    markEveryMs: 200,
    pacing: { enabled: true }
  },
  callbacks: {
    onCallStart: (metadata) => {},
    onRealtimeEvent: ({ event, metadata }) => {},
    onMark: ({ name, metadata, playedMs }) => {},
    onDtmf: ({ digit, metadata }) => {},
    onError: ({ message, code, metadata }) => {}
  }
});
```

Then, for each incoming WebSocket connection:

```ts
await bridge.handleConnection(ws, req);
```

`ws` only needs to match the minimal `TwilioMediaStreamsWsLike` interface (`on`, `send`, `close`, optional `readyState`).

---

## Security model (required)

Twilio Media Streams is a WebSocket connection; you typically cannot rely on custom headers for auth. This bridge enforces a **signed query token** on connect:

- The client connects to: `wss://your-host/.../twilio/media?token=...`
- `handleConnection()` validates the token before accepting any messages
- If token verification fails, the socket is closed with code `1008` (policy violation)

### Token format

The bridge uses the library’s signed-token verifier (`verifySignedWsToken`) which expects:

- `token = base64url(jsonPayload) + "." + base64url(hmacSha256(secret, payloadB64))`
- payload includes:
  - `iat` (seconds)
  - `exp` (seconds)
  - `nonce` (string)

### Recommended posture

- Use a short TTL (e.g. 60–300s)
- Rotate `tokenSecret`
- Optionally set `allowedAccountSids` to reject unexpected calls after the Twilio `start` event
- Set conservative limits/timeouts (see defaults above)
- Do not log raw audio payloads or secrets

---

## Call metadata

On Twilio `start`, the bridge extracts and surfaces:

```ts
interface TwilioCallMetadata {
  streamSid: string;
  callSid: string;
  accountSid: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  customParameters: Record<string, string>;
}
```

Notes:

- `callSid` / `accountSid` are read from the Twilio `start` payload (if missing they default to `""`).
- `from`, `to`, and `direction` are best provided via TwiML `<Parameter>` values (Twilio places them under `start.customParameters`).
- `direction` accepts `direction` or `callDirection` (case-insensitive). Any value other than `"outbound"` is treated as `"inbound"`.

---

## DTMF (touch tones)

Twilio sends keypad presses as `dtmf` events. The bridge handles DTMF in two ways:

1. **Callback**: `callbacks.onDtmf({ digit, metadata })` fires for every inbound digit.
2. **Session forwarding**: every digit is forwarded into the realtime session via `session.sendDTMF(digit)`.

Forwarding DTMF into the session makes it model-visible (as provider-agnostic user input) and emits normalized realtime events:

- `user_dtmf.digit`
- `user_dtmf.sequence` (when buffering is enabled)

DTMF behavior is configured on the session spec (`RealtimeSessionSpec.dtmf`), not on the bridge:

```ts
dtmf: {
  mode: 'digit', // or 'sequence'
  terminators: ['#'], // sequence mode only
  maxDigits: 32 // sequence mode only
}
```

In `digit` mode, each key press is injected as a user turn and committed immediately. In `sequence` mode, digits are buffered until a terminator/max-length flush, then the full sequence is injected and committed.

---

## Audio behavior

### Inbound (caller → session)

- Twilio inbound audio is assumed to be **g711_ulaw @ 8000 Hz mono** (the common Media Streams format).
- Before the realtime session is `ready`, inbound frames are buffered (bounded by `maxPendingInboundFrames`).
- After `ready`, inbound frames are converted to the session’s negotiated `audio.input` spec if needed, then forwarded via `session.sendAudio(...)`.

### Outbound (session → caller)

- Assistant audio chunks (`assistant_audio.chunk`) are converted to **g711_ulaw @ 8000 Hz mono**, framed into `frameMs` chunks, then sent as Twilio `media` messages.
- `mark` messages are emitted periodically (`markEveryMs`) to track playback progress (via Twilio inbound `mark` acknowledgements).
- Outbound audio buffering is bounded by `maxPendingOutboundAudioMs`. If the pending queue would exceed this limit, the bridge:
  - emits `callbacks.onError({ code: "outbound_backpressure" })`
  - sends a Twilio `{ event: "clear" }` to stop playback
  - interrupts the session (`session.interrupt({ reason: "outbound_backpressure" })`)

### Pacing (telephony-friendly)

Telephony buffers outbound audio. Sending too fast increases latency and makes interruption ineffective.

By default, outbound audio is paced with `AudioPacer` so bytes are sent at roughly real-time speed. You can disable pacing via:

```ts
audio: { pacing: { enabled: false } }
```

---

## Interruption (barge-in)

This bridge treats the realtime session’s normalized playback control event as authoritative:

- On `playback.clear_requested` (from `session.events()`):
  - drop queued outbound audio
  - reset pacing state
  - send Twilio `{ event: "clear" }` to stop playback immediately

In practice, `playback.clear_requested` is emitted when:

- the session is explicitly interrupted (`session.interrupt()`)
- barge-in triggers fire inside the realtime session controller (e.g. on `user_speech.started` when enabled)
- a session timeout/error requests playback to stop

---

## TwiML examples (inbound/outbound)

You must return TwiML that instructs Twilio to open a Media Stream to your server.

Minimal shape (parameters are recommended so `from/to/direction` are available):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://YOUR_HOST/twilio/media?token=SIGNED_TOKEN">
      <Parameter name="from" value="+15551234567" />
      <Parameter name="to" value="+15557654321" />
      <Parameter name="direction" value="inbound" />
    </Stream>
  </Connect>
</Response>
```

How you generate `SIGNED_TOKEN` and where you host the `/twiml` endpoint is up to your app/server.

---

## Minimal server sketch (local dev)

This module does not start servers for you — it only bridges an already-established WebSocket connection.

At a high level your app needs:

1) an HTTP endpoint that returns TwiML containing a `wss://...` Stream URL with a signed token
2) a WebSocket server endpoint that accepts Twilio’s Media Streams connection and calls `bridge.handleConnection(ws, req)`

Pseudo-code (illustrative only):

```ts
import http from 'http';
import { WebSocketServer } from 'ws';
import { createRealtimeSession } from 'llm-adapter/realtime';
import { createTwilioMediaStreamsBridge } from './plugins/voice-modules/twilio-media-streams/index.js';

const bridge = createTwilioMediaStreamsBridge({
  createSession: async ({ metadata }) => {
    return createRealtimeSession({
      provider: process.env.REALTIME_PROVIDER_ID,
      model: process.env.REALTIME_MODEL,
      // enable barge-in so `playback.clear_requested` can be emitted
      bargeIn: { enabled: true, triggers: ['user_speech.started'] },
      metadata
    } as any);
  },
  security: { tokenSecret: process.env.TWILIO_STREAM_TOKEN_SECRET }
});

const server = http.createServer((_req, res) => {
  // serve TwiML here
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end('<Response>...</Response>');
});

const wss = new WebSocketServer({ server, path: '/twilio/media' });
wss.on('connection', (ws, req) => void bridge.handleConnection(ws as any, req as any));

server.listen(3000);
```

If you see `1008 Unauthorized` immediately, the signed-token check is failing (missing/invalid/expired token or secret mismatch).

## Runnable example

See `plugins/voice-modules/twilio-media-streams/examples/twilio-inbound/` for a runnable inbound-call bridge example (TwiML endpoint + WebSocket server).

---

## Troubleshooting

- **Immediate 1008 close (Unauthorized)**: token missing/invalid/expired or `tokenSecret` mismatch.
- **Immediate 1008 close (Missing start)**: Twilio didn’t send `start` within `startTimeoutMs`.
- **1013 close (Busy)**: inbound backpressure (`maxPendingInboundFrames`) exceeded.
- **Delayed interruption**: ensure pacing is enabled and you honor `playback.clear_requested` in your realtime session config (barge-in enabled).
