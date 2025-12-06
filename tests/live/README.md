## Live test parallelism

- Default workers: `maxWorkersDefault` in `tests/live/config.ts` (currently 1).
- Override per run:
  - Env: `MAX_WORKERS=2 npm run test:live:openrouter`
  - CLI: `npm run test:live:openrouter -- --maxWorkers=2`
- Provider selection: first positional arg to `test:live` scripts (e.g. `npm run test:live:openrouter` sets `LLM_TEST_PROVIDERS=openrouter`).
- Custom patterns: pass `--testPathPattern=<pattern>`; defaults to `live` when not provided.
