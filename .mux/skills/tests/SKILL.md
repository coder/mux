---
name: tests
description: Testing doctrine, commands, and test layout conventions
---

# Testing Guidelines

## Testing Doctrine

Two types of tests are preferred:

1. **True integration tests** — use real runtimes, real filesystems, real network calls. No mocks, stubs, or fakes. These prove the system works end-to-end.
2. **Unit tests on pure/isolated logic** — test pure functions or well-isolated modules where inputs and outputs are clear. No mocks needed because the code has no external dependencies.

Avoid mock-heavy tests that verify implementation details rather than behavior. If you need mocks to test something, consider whether the code should be restructured to be more testable.

## Documentation

- Developer/test notes belong inline as comments.
- Test documentation stays inside the relevant test file as commentary explaining setup/edge cases.

## Runtime & Checks

- Never kill the running Mux process; rely on `make typecheck` + targeted `bun test path/to/file.test.ts` for validation (run `make test` only when necessary; it can be slow).
- Always run `make typecheck` after changes (covers main + renderer).
- **Before committing, run `make static-check`** (includes typecheck, lint, fmt-check, and docs link validation).
- Place unit tests beside implementation (`*.test.ts`). Reserve `tests/` for heavy integration/E2E cases.
- Run unit suites with `bun test path/to/file.test.ts`.
- Skip tautological tests (simple mappings, identical copies of implementation); focus on invariants and boundary failures.
- Keep utils pure or parameterize external effects for easier testing.

## Coverage Expectations

- Prefer fixes that simplify existing code; such simplifications often do not need new tests.
- When adding complexity, add or extend tests. If coverage requires new infrastructure, propose the harness and then add the tests there.

## TDD Expectations

- When asked for TDD, write real repo tests (no `/tmp` scripts) and commit them.
- Pull complex logic into easily tested utils. Target broad coverage with minimal cases that prove the feature matters.

## Storybook

- **Settings UI coverage:** if you add a new Settings modal section (or materially change an existing one), add/update an `App.settings.*.stories.tsx` story that navigates to that section so Chromatic catches regressions.
- **Only** add full-app stories (`App.*.stories.tsx`). Do not add isolated component stories, even for small UI changes (they are not used/accepted in this repo).
- Use play functions with `@storybook/test` utilities (`within`, `userEvent`, `waitFor`) to interact with the UI and set up the desired visual state. Do not add props to production components solely for storybook convenience.
- Keep story data deterministic: avoid `Math.random()`, `Date.now()`, or other non-deterministic values in story setup. Pass explicit values when ordering or timing matters for visual stability.
- **Scroll stabilization:** After async operations that change element sizes (Shiki highlighting, Mermaid rendering, tool expansion), wait for `useAutoScroll`'s ResizeObserver RAF to complete. Use double-RAF: `await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`.

## UI Tests (`tests/ui`)

- Tests in `tests/ui` must render the **full app** via `AppLoader` and drive interactions from the **user's perspective** (clicking, typing, navigating).
- Use `renderReviewPanel()` helper or similar patterns that render `<AppLoader client={apiClient} />`.
- Never test isolated components or utility functions here—those belong as unit tests beside implementation (`*.test.ts`).
- **Never call backend APIs directly** (e.g., `env.orpc.workspace.remove()`) to trigger actions that you're testing—always simulate the user action (click the delete button, etc.). Calling the API bypasses frontend logic like navigation, state updates, and error handling, which is often where bugs hide. Backend API calls are fine for setup/teardown or to avoid expensive operations.
- These tests require `TEST_INTEGRATION=1` and real API keys; use `shouldRunIntegrationTests()` guard.

## Integration Testing

- Use `bun x jest` (optionally `TEST_INTEGRATION=1`). Examples:
  - `TEST_INTEGRATION=1 bun x jest tests/integration/sendMessage.test.ts -t "pattern"`
  - `TEST_INTEGRATION=1 bun x jest tests`
- `tests/integration` is slow; filter with `-t` when possible. Tests use `test.concurrent()`.
- Never bypass IPC: do not call `env.config.saveConfig`, `env.historyService`, etc., directly. Use `env.mockIpcRenderer.invoke(IPC_CHANNELS.CONFIG_SAVE|HISTORY_GET|WORKSPACE_CREATE, ...)` instead.
- Acceptable exceptions: reading config to craft IPC args, verifying filesystem after IPC completes, or loading existing data to avoid redundant API calls.
