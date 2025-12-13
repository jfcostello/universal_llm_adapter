# `modules/messages`

Message preparation and mutation helpers used by coordinators and tool loops.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/messages/index.ts` (tests may import internals).

## Exports
- `prepareMessages(spec)` – constructs the final message array (system + user messages).
- `aggregateSystemMessages(messages)` – merges multiple system messages into one.
- `appendAssistantToolCalls(messages, toolCalls, options)` – appends an assistant message containing tool calls.
- `appendToolResult(messages, payload, options)` – appends a tool result message.

