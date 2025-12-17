# Audio module

Provider-agnostic audio utilities used by realtime voice + telephony transports.

This module intentionally uses codec/sample-rate terminology only (no provider or transport specifics).

## Scope

### Supported codecs
- `pcm16` (signed 16-bit little-endian linear PCM)
- `g711_ulaw` (G.711 μ-law, 8-bit)

### Common sample rates
- `8000 Hz` (telephony)
- `16000 Hz` (speech)
- `24000 Hz` (higher-fidelity speech)

## API

Import from `modules/audio/index.js`.

### Base64 helpers
- `bytesToBase64(bytes)` → `string`
- `base64ToBytes(base64)` → `Uint8Array`

### PCM16 helpers
- `pcm16leBytesToSamples(bytes)` → `Int16Array`
- `pcm16leSamplesToBytes(samples)` → `Uint8Array`

### G.711 μ-law helpers
- `encodePcm16SamplesToG711UlawBytes(samples)` → `Uint8Array`
- `decodeG711UlawBytesToPcm16Samples(bytes)` → `Int16Array`
- `pcm16leBytesToG711UlawBytes(bytes)` → `Uint8Array`
- `g711UlawBytesToPcm16leBytes(bytes)` → `Uint8Array`

### Framing helpers
- `bytesPerSample(format)` → `number`
- `bytesForDurationMs({ format, sampleRateHz, channels, durationMs })` → `number`
- `durationMsForBytes({ format, sampleRateHz, channels, byteLength })` → `number`
- `splitBytesIntoFrames({ bytes, format, sampleRateHz, channels, frameMs })` → `Uint8Array[]`

Notes:
- Framing is purely arithmetic; it does not interpret the payload beyond bytes-per-sample rules.
- The final frame may be shorter than the requested frame size.

### Resampling (PCM16)
- `resamplePcm16Samples({ samples, fromSampleRateHz, toSampleRateHz, channels })` → `Int16Array`
- `resamplePcm16leBytes({ bytes, fromSampleRateHz, toSampleRateHz, channels })` → `Uint8Array`

Resampling uses deterministic linear interpolation. It is designed for speech use-cases where simplicity and determinism are preferred.

### Playback pacing
Telephony transports typically buffer outbound audio. If you send audio faster than real time, latency increases and interruption becomes less effective.

`AudioPacer` implements a timestamp-based pacing strategy:
- you call `paceBytes(...)` (or `paceDurationMs(...)`) before sending each chunk
- it delays sending so total outbound audio time roughly matches wall-clock time

The pacer is designed with injectable `now()` and `sleep()` dependencies so it can be tested deterministically and can be adapted to different runtimes.

