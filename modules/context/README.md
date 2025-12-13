# `modules/context`

Conversation context helpers: pruning, token estimation, and trimming to a token budget.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/context/index.ts` (tests may import internals).

## Exports
- `pruneToolResults(messages, preserveCount?)`
- `pruneReasoning(messages, preserveCount?)`
- `estimateMessageTokens(message)`
- `calculateConversationTokens(messages)`
- `trimConversationToBudget(messages, maxTokens, options?)`

