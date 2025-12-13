# `modules/lifecycle`

Lifecycle wrappers for running coordinators with consistent setup/teardown:
- plugin registry creation/loading
- coordinator creation
- guaranteed coordinator close
- optional logger close

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/lifecycle/index.ts` (tests may import internals).

