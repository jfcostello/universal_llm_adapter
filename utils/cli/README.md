# CLI Utilities

Shared helpers for CLI entrypoints and other transport adapters.

## Public API

All consumers must import only from `utils/cli/index.ts`.

### `loadSpec<T>(options, stdin?)`

Loads a JSON spec from, in order of precedence:
1. `options.file` – path to a JSON file.
2. `options.spec` – inline JSON string.
3. `stdin` – UTF‑8 stream fallback.

Returns the parsed JSON as type `T`. Errors from file I/O or JSON parsing are propagated.

### `writeJsonToStdout(value, options?)`

Writes `value` to stdout as JSON with a trailing newline.

Options:
- `pretty` (boolean, default `false`): pretty‑print JSON.
- `timeoutMs` (number, default `100`): resolve even if stdout callback never fires.
- `stdout` (WritableStream, default `process.stdout`): override output stream for tests/other adapters.

The helper races the write completion callback against a short timeout to avoid truncation when stdout is piped.

