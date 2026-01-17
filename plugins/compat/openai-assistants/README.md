# `plugins/compat/openai-assistants`

SDK-based compat implementation for the Assistants API.

## Public API
- Default export from `index.ts`

## Requirements
- `settings.assistantId` is required for every call.

## Behavior
- Uses the OpenAI Node SDK `beta.threads` API to execute runs (SDK-based provider; no HTTP payload is sent).
- Supports both non-stream and streaming flows:
  - `callSDK()` uses `createAndRunPoll(...)` and returns an adapter `LLMResponse`.
  - `streamSDK()` uses `createAndRunStream(...)` and yields Assistants stream events; the adapter tool loop consumes them via `parseStreamChunk(...)`.

## Message mapping
- System message text → run `instructions` (text-only, trimmed; omitted when empty).
- User/assistant messages → thread `messages` in Assistants format.
- Images → `image_url` content parts.
- Documents:
  - Included as a small placeholder text in the thread message content.
  - Uploaded/attached for `file_search` via `thread.tool_resources.file_search.vector_stores`.

## Tools + tool loop integration
- Adapter tools are serialized as Assistants `function` tools.
- When a run returns `requires_action.submit_tool_outputs`, compat returns tool calls in the adapter format and stores `{ threadId, runId }` in `toolCall.metadata`.
- Follow-up calls detect tool results and submit them back to the same run via `submitToolOutputsAndPoll(...)` / `submitToolOutputsStream(...)`.

## Documents support
- `DocumentContent.source.type` handling:
  - `file_id` → used directly.
  - `base64` / `filepath` → uploaded via `client.files.create({ purpose: "assistants" })`, then attached as `file_search` resources.
  - `url` → rejected (not supported for this compat).

## Azure vs OpenAI
Client selection is based on headers:
- Azure is selected when `headers["api-key"]` is provided, plus:
  - `headers["x-azure-endpoint"]` or `AZURE_OPENAI_ENDPOINT`
  - `headers["x-openai-api-version"]` or `OPENAI_API_VERSION`
- Otherwise OpenAI is selected via `headers.Authorization` (`Bearer ...`) or `OPENAI_API_KEY`.

## Internal layout (A)
- `internal/openai-assistants.ts` – compat implementation (orchestration)
- `internal/mappings.ts` – shared types/constants
- `internal/messages.ts` – message serialization + instruction extraction
- `internal/settings.ts` – run params + document upload + attachments
- `internal/tools.ts` – tool + tool_choice serialization
- `internal/stream.ts` – stream event parsing
- `internal/response.ts` – run status + message parsing

## Notes
- Loaded by the plugin registry via the provider's `compat` setting.
- Implementation details live in `internal/` and must not be imported directly outside this directory.
