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

- Default workers: `maxWorkersDefault` in `tests/live/config.ts` (currently 5).
- Override per run:
  - Env: `MAX_WORKERS=2 npm run test:live:openrouter`
  - CLI: `npm run test:live:openrouter -- --maxWorkers=2`
- Provider selection: first positional arg to `test:live` scripts (e.g. `npm run test:live:openrouter` sets `LLM_TEST_PROVIDERS=openrouter`).
- Custom patterns: pass `--testPathPattern=<pattern>`; defaults to `live` when not provided.

## Live test transport

Live tests can submit coordinator work via either:

- **CLI** (default): spawns the coordinator CLI per call.
- **Server**: starts one server instance and submits requests over HTTP (closest to real production usage).
- **Both**: runs the full suite twice (CLI pass, then server pass).

Select transport with either:

- CLI flag: `--transport=cli|server|both`
- Env var: `LLM_LIVE_TRANSPORT=cli|server|both`

Examples:

```bash
# Default (CLI)
npm run test:live:openrouter

# Server only
npm run test:live:openrouter -- --transport=server

# Full run twice (CLI then server)
npm run test:live:openrouter -- --transport=both
```

Notes:
- Server transport generates a run-wide batch id and exposes it to tests as `LLM_LIVE_BATCH_ID` for batch logging assertions.
- Server transport writes a server process log under `tests/live/logs/` and correlates each request via `spec.metadata.correlationId`.
- Live tests `15–19` (embeddings/vector) are supported in server transport.

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

## Vector Store Live Tests

The vector store live tests (files 16-19) test against real Qdrant Cloud instances. These tests:

1. **Create timestamped collections**: Each test run creates unique collections with names like `test_collection_${Date.now()}` to avoid conflicts between concurrent test runs.

2. **Automatic cleanup**: All test files delete their collections in `afterAll` hooks, ensuring no orphaned collections remain on the Qdrant account.

3. **Deletion verification**: After deleting a collection, tests verify the deletion succeeded by checking `collectionExists()` returns `false`. This ensures cleanup is part of the pass criteria.

### Required Environment Variables

```bash
QDRANT_CLOUD_URL=https://your-cluster.cloud.qdrant.io:6333
QDRANT_API_KEY=your-api-key
OPENROUTER_API_KEY=your-openrouter-key  # For embeddings
```

### Running Vector Store Tests

```bash
# Run all vector store tests
npm run test:live:openrouter

# Run specific vector store test
LLM_LIVE=1 npx jest tests/live/test-files/16-vector-store.live.test.ts
```
