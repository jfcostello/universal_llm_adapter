## Running All Tests

Use `npm run test:all` to run both unit tests and live tests with a combined summary:

```
npm run test:all
```

This runs:
1. Unit tests with 100% coverage requirement
2. Live tests against real LLM providers

At the end, a combined summary shows pass/fail counts for both suites.

## Live test parallelism

- Default workers: `maxWorkersDefault` in `tests/live/config.ts` (currently 1).
- Override per run:
  - Env: `MAX_WORKERS=2 npm run test:live:openrouter`
  - CLI: `npm run test:live:openrouter -- --maxWorkers=2`
- Provider selection: first positional arg to `test:live` scripts (e.g. `npm run test:live:openrouter` sets `LLM_TEST_PROVIDERS=openrouter`).
- Custom patterns: pass `--testPathPattern=<pattern>`; defaults to `live` when not provided.

## Test Scripts

| Script | Description |
|--------|-------------|
| `npm test` | Run unit tests only with coverage |
| `npm run test:all` | Run unit + live tests with combined summary |
| `npm run test:live` | Run all live tests |
| `npm run test:live:openrouter` | Run live tests with OpenRouter |
| `npm run test:live:anthropic` | Run live tests with Anthropic |
| `npm run test:live:openai` | Run live tests with OpenAI |
| `npm run test:live:google` | Run live tests with Google |
