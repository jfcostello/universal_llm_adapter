# CLI Module

Unified CLI for all LLM Adapter operations.

## Architecture

The CLI module provides a single unified command-line interface (`llm-adapter`) that handles:
- LLM operations (run, stream)
- Vector store operations (run, stream, query, embed, upsert, delete, collections)
- Embedding operations (run)
- Server management (serve)

### Lazy Loading

The CLI is designed for strict lazy loading. Running `llm-adapter --help` loads ONLY the `commander` package - no heavy modules (kernel, llm, vector, embeddings) are imported until a command is actually executed.

All heavy imports are done dynamically inside action handlers:

```typescript
.action(async (options) => {
  // Dynamic imports - only loaded when this command runs
  const { loadSpec } = await import('./spec-loader.js');
  const { runWithCoordinatorLifecycle } = await import('../../lifecycle/index.js');
  // ...
});
```

### Dependency Injection

The CLI supports full dependency injection for testing:

```typescript
const program = createUnifiedProgram({
  createRegistry: myMockRegistry,
  createLlmCoordinator: myMockCoordinator,
  // ...
});
```

## Import Rules

- Runtime code must import only from `modules/cli/index.ts`.
- Do not import from `modules/cli/internal/**` outside of this module.

## Public API

### Unified CLI (Recommended)

```typescript
import { createUnifiedProgram, runUnifiedCli } from 'llm-adapter/cli';

// Create program with custom dependencies
const program = createUnifiedProgram(partialDeps);

// Or run with default dependencies
await runUnifiedCli(['node', 'llm-adapter', 'run', '--spec', '...']);
```

### Spec + Output Helpers

```typescript
import { loadSpec, writeJsonToStdout } from 'llm-adapter/cli';

// Load spec from file or JSON string
const spec = await loadSpec<LLMCallSpec>({ file: 'spec.json' });

// Write JSON to stdout with proper flushing
await writeJsonToStdout(response, { pretty: true });
```

### Legacy Program Factories (Deprecated)

These are kept for backwards compatibility but will be removed in a future version:

```typescript
import {
  createLlmCoordinatorProgram,
  runLlmCoordinatorCli,
  createVectorStoreCoordinatorProgram,
  runVectorStoreCoordinatorCli
} from 'llm-adapter/cli';
```

## CLI Commands

### LLM Operations

```bash
# Non-streaming LLM call
llm-adapter run --spec '{"messages":[],"llmPriority":[]}'
llm-adapter run --file spec.json

# Streaming LLM call
llm-adapter stream --spec '{"messages":[],"llmPriority":[]}'
```

### Vector Operations

```bash
# Generic vector operation
llm-adapter vector run --spec '{"operation":"query","store":"my-store"}'
llm-adapter vector stream --spec '{"operation":"embed","store":"my-store"}'

# Shortcut commands
llm-adapter vector query --spec '...'
llm-adapter vector embed --spec '...'
llm-adapter vector upsert --spec '...'
llm-adapter vector delete --spec '...'
llm-adapter vector collections --spec '...'
```

### Embedding Operations

```bash
llm-adapter embeddings run --spec '{"operation":"embed","embeddingPriority":[]}'
```

### Server

```bash
llm-adapter serve --port 3000 --host 127.0.0.1
```

## Common Options

All commands support:

- `-f, --file <path>`: Path to spec JSON file
- `-s, --spec <json>`: Spec as JSON string
- `-p, --plugins <path>`: Path to plugins directory (default: `./plugins`)
- `--batch-id <id>`: Optional batch identifier for grouped logging
- `--pretty`: Pretty print output (run commands only)

## Entry Point

The CLI entry point is at `bin/cli.ts`. When installed globally or via npm link, the `llm-adapter` command becomes available.

```bash
# Via npx
npx llm-adapter run --spec '...'

# Via npm link
npm link
llm-adapter run --spec '...'

# Via tsx during development
npx tsx bin/cli.ts run --spec '...'
```
