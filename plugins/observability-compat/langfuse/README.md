# Langfuse Observability Compat

This compat module translates provider-agnostic LLM observability events into Langfuse's ingestion format.

## Overview

The Langfuse compat implements the `IObservabilityCompat` interface, providing:

- **`buildBatch()`**: Transforms internal `ObservabilityLLMRequestEvent` and `ObservabilityLLMResponseEvent` objects into Langfuse's batch ingestion format
- **`sendBatch()`**: Sends the batch payload to Langfuse's API with proper authentication

## Event Mapping

### LLM Request Events

Each request event is transformed into:
1. A `trace-create` event with the trace ID, session ID, and input messages
2. A `generation-create` event with model, parameters, and input

### LLM Response Events

Each response event is transformed into:
1. A `generation-update` event with output, usage statistics, and any errors

## Configuration

The compat uses the provider manifest for configuration:

- **Endpoint**: Configurable via `LANGFUSE_HOST` environment variable (defaults to `https://cloud.langfuse.com`)
- **Authentication**: Basic auth using `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` environment variables

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LANGFUSE_PUBLIC_KEY` | Yes | Langfuse project public key |
| `LANGFUSE_SECRET_KEY` | Yes | Langfuse project secret key |
| `LANGFUSE_HOST` | No | Custom Langfuse host (default: `https://cloud.langfuse.com`) |

## Langfuse API Format

The compat sends events to `/api/public/ingestion` with the following structure:

```json
{
  "batch": [
    {
      "id": "envelope-uuid",
      "type": "trace-create|generation-create|generation-update",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "body": { ... }
    }
  ],
  "metadata": {
    "sdk_name": "universal-llm-adapter",
    "sdk_version": "1.0.0"
  }
}
```

## Response Handling

- **200**: All events ingested successfully
- **207**: Partial success - per-event outcomes are parsed
- **429/5xx**: Retryable errors - events will be retried with exponential backoff
- **4xx**: Non-retryable errors - events are dropped

## Usage

This compat is automatically loaded when the `langfuse` observability provider is configured:

```typescript
import { run } from 'universal-llm-adapter';

const response = await run({
  provider: 'openai',
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
  observability: {
    enabled: true,
    provider: 'langfuse'
  }
});
```
