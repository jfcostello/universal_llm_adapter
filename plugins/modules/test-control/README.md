# test-control (plugin module)

Live-test helper tool used by the live suite.

## Tool names
- `test.control` (terminal by definition)
- `test.control.nonterminal` (non-terminal by definition)

Both route to the same module handler.

## Args
- `override`: the value the tool returns as `tool_type_response_override_terminal` (nested inside `result`).
  - strict booleans (`true`/`false`) are honored by the tool loop
  - non-boolean values are ignored by the tool loop
- `sleepMs`: optional delay before returning (used to force deterministic timeouts)
