# Sandbox runner

Ad-hoc CLI runner for the LLM coordinator. It sends a multi-turn conversation defined in a single YAML file, prints each turn to the console, and saves a transcript plus copied logs under `tests/sandbox/logs/`.

## Prerequisites
- Build the CLI once: `npm run build` (produces `dist/llm_coordinator.js`).
- Provide any plugin/config paths referenced by your scenario.

## Usage
```
npm run sandbox:cli -- --scenario tests/sandbox/scenarios/example.yml
```

Flags:
- `--scenario <path>`: required YAML file.
- `--dry-run`: validate and print scenario metadata without calling the coordinator.

## Scenario YAML schema (high level)
- `run`: metadata  
  - `name` (string, optional) – used for artifact folder naming.  
  - `mode` (`run` | `stream`, default `run`).  
  - `pluginsPath` (string, default `./plugins`).  
  - `batchId` (string, optional) – forwarded to logging.  
  - `copyLogs` (bool, default `true`) – copy `./logs` into the sandbox run folder.  
  - `transcriptPath` (string, optional) – custom transcript location.
- `env` (object, optional): extra environment variables for the CLI process.
- `spec`: base `LLMCallSpec` fields (everything except `messages`, which are built per turn). Includes `systemPrompt`, `llmPriority`, `settings`, `tools`, `functionToolNames`, `mcpServers`, `vectorContext`, etc.
- `initialMessages` (array, optional): pre-seeded history (e.g., tool results or assistant replies) before the scripted turns.
- `turns` (array, required): ordered user turns. Each item can be a string or an object with `role` (defaults to `user`) and `content` (string or content parts).

## Outputs
- Transcript (user + assistant only) saved to `tests/sandbox/logs/<runName>/transcript.txt` (or custom path) and echoed live.
- Logs copied from `./logs` into `tests/sandbox/logs/<runName>/logs/` when `copyLogs` is true. Originals remain untouched.

## Notes
- The runner calls the published CLI as an external process; it does not import coordinator code directly.
- Sandbox files live under `tests/sandbox/` and are outside Jest patterns, so coverage is unaffected.
