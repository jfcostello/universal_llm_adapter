# Base Logger (internal)

Base logging implementation and configuration shared by adapter loggers.

## Entry points
- `index.ts`: exports logger config helpers/constants plus `BaseAdapterLogger` and related types.
- `internal/*`: concrete implementations (config parsing, formatting, transports, log level).

## Responsibilities
- Define common logger configuration (log directories, retention limits, env-driven toggles).
- Provide a base adapter logger implementation used by higher-level logging modules.
- Provide transports and formatting utilities used by loggers.

## Import rules
- Runtime code should import from `modules/logging/index.ts`.
- Do not import from `modules/logging/internal/base-logger/internal/**` outside of `modules/logging`.

