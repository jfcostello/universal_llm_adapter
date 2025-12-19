# `plugins/embedding-compat/test`

Deterministic, offline embedding compat used for tests and local development.

## Purpose

Some integration tests require a real `PluginRegistry` and a real `EmbeddingManager`, but should not depend on external network calls. This compat produces stable vectors locally so vector-store flows can be tested reliably.

## How it works

- Tokenizes text into lowercase alphanumeric tokens.
- Hashes each token into a fixed-dimension vector bucket.
- Normalizes each vector to unit length (when non-empty).

This produces consistent vectors where texts sharing tokens are more similar under cosine similarity.

## Usage

Pair this compat with an embedding provider config in `plugins/embeddings/*.json`:

- `kind`: `test` (matches this compat folder name)
- `dimensions`: vector size (defaults to `64` if omitted)

Then reference the provider ID in `embeddingPriority` when embedding/querying with text.

