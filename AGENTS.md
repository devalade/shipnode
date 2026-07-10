# Agent Instructions

## Git branch naming

- Never create branches with the `codex/` prefix.
- For implementation PRs, use descriptive prefixes such as `feature/`, `fix/`, `chore/`, or the repository's established convention.

## Error handling

- Use `better-result` for expected/domain failures in new TypeScript code.
- Prefer `Result<T, E>` with typed `TaggedError` classes for recoverable errors such as missing app targets, invalid server targets, missing accessories, validation failures, and command precondition failures.
- Keep exceptions for programmer defects and unexpected infrastructure failures at process or adapter boundaries.
- At CLI boundaries, convert `Result.err(...)` into a clear `ui.error(...)` message and exit code `1`.
- Use the project-local skills when adopting or migrating error handling:
  - `.claude/skills/better-result-adopt`
  - `.claude/skills/better-result-migrate-v2`
