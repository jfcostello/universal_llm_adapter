Launch utilities for live Jest runs.

- enforce worker concurrency via `tests/live/config.ts` only (hard-fail on `MAX_WORKERS` / `--maxWorkers`)
- allow optional provider positional arg (sets `LLM_TEST_PROVIDERS`)
- assemble Jest args for the live test suite
