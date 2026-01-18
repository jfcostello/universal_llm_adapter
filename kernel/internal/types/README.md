# Kernel Types (internal)

This directory owns the kernel’s internal type exports and default-shape helpers.

`kernel/internal/types/index.ts` is the single entrypoint for these exports; `kernel/internal/types.ts` re-exports it to preserve the previous public surface.

## Responsibilities
- Define shared types used across the repo (chat/messages, LLM, tools, vector, embeddings, compat, observability).
- Centralize default-shaped type helpers (see `internal/defaults.ts`).

## Layout
- `index.ts`: re-exports internal type modules.
- `internal/*.ts`: domain-grouped type definitions.

## Import rules
- Runtime code must import from `kernel/index.ts`.
- Do not import from `kernel/internal/types/**` outside the kernel.

