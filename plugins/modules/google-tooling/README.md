# `plugins/modules/google-tooling`

Shared helpers for interacting with Google-style function calling configuration.

This module is provider-specific, so it intentionally lives under `/plugins`.

## Exports

- `convertSchemaToGoogleFormat(schema)` — converts JSON Schema to the Google parameters format.
- `serializeToolsForSDK(tools)` — converts unified tools into `functionDeclarations` tool config.
- `serializeToolChoiceForSDK(choice, tools?)` — converts unified tool choice into a Google tool config.
