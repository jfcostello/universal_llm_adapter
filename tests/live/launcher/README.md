Launch utilities for live Jest runs.

- parse CLI/env to pick `maxWorkers` (CLI `--maxWorkers` > `MAX_WORKERS` env > `maxWorkersDefault` in `tests/live/config.ts`)
- allow optional provider positional arg (sets `LLM_TEST_PROVIDERS`)
- assemble Jest args for the live test suite
