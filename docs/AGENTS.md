---
title: AGENTS.md
description: Agent instructions for AI assistants working on the Mux codebase
---

**Prime directive:** keep edits minimal and token-efficient—say only what conveys actionable signal.

## Project Snapshot

- `mux`: Electron + React desktop app for parallel agent workflows; UX must be fast, responsive, predictable.
- Minor breaking changes are expected, but critical flows must allow upgrade↔downgrade without friction; skip migrations when breakage is tightly scoped.
- Public work (issues/PRs/commits) must use 🤖 in the title and include this footer in the body:

  ```md
  ---
  _Generated with `mux` • Model: `<modelString>` • Thinking: `<thinkingLevel>` • Cost: `$<costs>`_
  <!-- mux-attribution: model=<modelString> thinking=<thinkingLevel> costs=<costs> -->
  ```

  Always check `$MUX_MODEL_STRING`, `$MUX_THINKING_LEVEL`, and `$MUX_COSTS_USD` via bash before creating or updating PRs—include them in the footer if set.

## PR + Release Workflow

- Reuse existing PRs; never close or recreate without instruction. Force-push updates.
- After every push run `./scripts/wait_pr_checks.sh <pr_number>` to ensure CI passes.

- When posting multi-line comments with `gh` (e.g., `@codex review`), **do not** rely on `\n` escapes inside quoted `--body` strings (they will be sent as literal text). Prefer `--body-file -` with a heredoc to preserve real newlines:

```bash
gh pr comment <pr_number> --body-file - <<'EOF'
@codex review

<message>
EOF
```
- If Codex left review comments and you addressed them, push your fixes, resolve the PR comment, and then comment `@codex review` to re-request review. After that, re-run `./scripts/wait_pr_checks.sh <pr_number>` and `./scripts/check_codex_comments.sh <pr_number>`.
- Generally run `wait_pr_checks` after submitting a PR to ensure CI passes.
- Status decoding: `mergeable=MERGEABLE` clean; `CONFLICTING` needs resolution. `mergeStateStatus=CLEAN` ready, `BLOCKED` waiting for CI, `BEHIND` rebase, `DIRTY` conflicts.
- If behind: `git fetch origin && git rebase origin/main && git push --force-with-lease`.
- Never enable auto-merge or merge at all unless the user explicitly says "merge it".
- Do not enable auto-squash or auto-merge on Pull Requests unless explicit permission is given.
- PR descriptions: include only information a busy reviewer cannot infer; focus on implementation nuances or validation steps.
- Title prefixes: `perf|refactor|fix|feat|ci|tests|bench`, e.g., `🤖 fix: handle workspace rename edge cases`.
- Use `tests:` for test-only changes (test helpers, flaky test fixes, storybook). Use `ci:` for CI config changes.

## Repo Reference

- Core files: `src/main.ts`, `src/preload.ts`, `src/App.tsx`, `src/config.ts`.
- Up-to-date model names: see `src/common/knownModels.ts` for current provider model IDs.
- Persistent data: `~/.mux/config.json`, `~/.mux/src/<project>/<branch>` (worktrees), `~/.mux/sessions/<workspace>/chat.jsonl`.

## Documentation Rules

- No free-floating Markdown. User docs live in `docs/` (read `docs/README.md`, add pages to `docs.json` navigation, use standard Markdown + mermaid). Developer/test notes belong inline as comments.
- For planning artifacts, use the `propose_plan` tool or inline comments instead of ad-hoc docs.
- Do not add new root-level docs without explicit request; during feature work rely on code + tests + inline comments.
- Test documentation stays inside the relevant test file as commentary explaining setup/edge cases.
- External API docs already live inside `/tmp/ai-sdk-docs/**.mdx`; never browse `https://sdk.vercel.ai/docs/ai-sdk-core` directly.

## Key Features & Performance

- Core UX: projects sidebar (left panel), workspace management (local git worktrees or SSH clones), config stored in `~/.mux/config.json`.
- Fetch bulk data in one IPC call—no O(n) frontend→backend loops.
- **React Compiler enabled** — auto-memoization handles components/hooks; do not add manual `React.memo()`, `useMemo`, or `useCallback` for memoization purposes. Focus instead on fixing unstable object references that the compiler cannot optimize (e.g., `new Set()` in state setters, inline object literals as props).
- **useEffect** — Before adding effects, consult the `react-effects` skill. Most effects for derived state, prop resets, or event-triggered logic are anti-patterns.

## Tooling & Commands

- Package manager: bun only. Use `bun install`, `bun add`, `bun run` (which proxies to Make when relevant). Run `bun install` if modules/types go missing.
- Makefile is source of truth (new commands land there, not `package.json`).
- Primary targets: `make dev|start|build|lint|lint-fix|fmt|fmt-check|typecheck|test|test-integration|clean|help`.
- Full `static-check` includes docs link checking via `mintlify broken-links`.

## Refactoring & Runtime Etiquette

- Use `git mv` to retain history when moving files.
- Never kill the running Mux process; rely on `make typecheck` + targeted `bun test path/to/file.test.ts` for validation (run `make test` only when necessary; it can be slow).

## Self-Healing & Crash Resilience

- Prefer **self-healing** behavior: if corrupted or invalid data exists in persisted state (e.g., `chat.jsonl`), the system should sanitize or filter it at load/request time rather than failing permanently.
- Never let a single malformed line in history brick a workspace—apply defensive filtering in request-building paths so the user can continue working.
- When streaming crashes, any incomplete state committed to disk should either be repairable on next load or excluded from provider requests to avoid API validation errors.
- **Startup-time initialization must never crash the app.** Wrap in try-catch, use timeouts, fall back silently.

## Testing Doctrine

Two types of tests are preferred:

1. **True integration tests** — use real runtimes, real filesystems, real network calls. No mocks, stubs, or fakes. These prove the system works end-to-end.
2. **Unit tests on pure/isolated logic** — test pure functions or well-isolated modules where inputs and outputs are clear. No mocks needed because the code has no external dependencies.

Avoid mock-heavy tests that verify implementation details rather than behavior. If you need mocks to test something, consider whether the code should be restructured to be more testable.

### Storybook

- **Only** add full-app stories (`App.*.stories.tsx`). Do not add isolated component stories, even for small UI changes (they are not used/accepted in this repo).
- Use play functions with `@storybook/test` utilities (`within`, `userEvent`, `waitFor`) to interact with the UI and set up the desired visual state. Do not add props to production components solely for storybook convenience.
- Keep story data deterministic: avoid `Math.random()`, `Date.now()`, or other non-deterministic values in story setup. Pass explicit values when ordering or timing matters for visual stability.
- **Scroll stabilization:** After async operations that change element sizes (Shiki highlighting, Mermaid rendering, tool expansion), wait for `useAutoScroll`'s ResizeObserver RAF to complete. Use double-RAF: `await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`.

### TDD Expectations

- When asked for TDD, write real repo tests (no `/tmp` scripts) and commit them.
- Pull complex logic into easily tested utils. Target broad coverage with minimal cases that prove the feature matters.

### General Rules

- Always run `make typecheck` after changes (covers main + renderer).
- **Before committing, run `make static-check`** (includes typecheck, lint, fmt-check, and docs link validation).
- Place unit tests beside implementation (`*.test.ts`). Reserve `tests/` for heavy integration/E2E cases.
- Run unit suites with `bun test path/to/file.test.ts`.
- Skip tautological tests (simple mappings, identical copies of implementation); focus on invariants and boundary failures.
- Keep utils pure or parameterize external effects for easier testing.

### UI Tests (`tests/ui`)

- Tests in `tests/ui` must render the **full app** via `AppLoader` and drive interactions from the **user's perspective** (clicking, typing, navigating).
- Use `renderReviewPanel()` helper or similar patterns that render `<AppLoader client={apiClient} />`.
- Never test isolated components or utility functions here—those belong as unit tests beside implementation (`*.test.ts`).
- **Never call backend APIs directly** (e.g., `env.orpc.workspace.remove()`) to trigger actions that you're testing—always simulate the user action (click the delete button, etc.). Calling the API bypasses frontend logic like navigation, state updates, and error handling, which is often where bugs hide. Backend API calls are fine for setup/teardown or to avoid expensive operations.
- These tests require `TEST_INTEGRATION=1` and real API keys; use `shouldRunIntegrationTests()` guard.

### Integration Testing

- Use `bun x jest` (optionally `TEST_INTEGRATION=1`). Examples:
  - `TEST_INTEGRATION=1 bun x jest tests/integration/sendMessage.test.ts -t "pattern"`
  - `TEST_INTEGRATION=1 bun x jest tests`
- `tests/integration` is slow; filter with `-t` when possible. Tests use `test.concurrent()`.
- Never bypass IPC: do not call `env.config.saveConfig`, `env.historyService`, etc., directly. Use `env.mockIpcRenderer.invoke(IPC_CHANNELS.CONFIG_SAVE|HISTORY_GET|WORKSPACE_CREATE, ...)` instead.
- Acceptable exceptions: reading config to craft IPC args, verifying filesystem after IPC completes, or loading existing data to avoid redundant API calls.

## Command Palette & UI Access

- Open palette with `Cmd+Shift+P` (mac) / `Ctrl+Shift+P` (win/linux); quick toggle via `Cmd+P` / `Ctrl+P`.
- Palette covers workspace mgmt, navigation, chat utils, mode/model switches, slash commands (`/` for suggestions, `>` for actions).

## Styling

- Colors defined in `src/browser/styles/globals.css` (`:root @theme` block). Reference via CSS variables (e.g., `var(--color-plan-mode)`), never hardcode hex values.

## TypeScript Discipline

- Ban `as any`; rely on discriminated unions, type guards, or authored interfaces.
- Use `Record<Enum, Value>` for exhaustive mappings to catch missing cases.
- Apply utility types (`Omit`, `Pick`, etc.) to build UI-specific variants of backend types, preventing unnecessary re-renders and clarifying intent.
- Let types drive design: prefer discriminated unions for state, minimize runtime checks, and simplify when types feel unwieldy.
- Use `using` declarations (or equivalent disposables) for processes, file handles, etc., to ensure cleanup even on errors.
- Centralize magic constants under `src/constants/`; share them instead of duplicating values across layers.
- Never repeat constant values (like keybinds) in comments—they become stale when the constant changes.
- **Avoid `void asyncFn()`** - fire-and-forget async calls hide race conditions. When state is observable by other code (in-memory cache, event emitters), ensure visibility order matches invariants. If memory and disk must stay in sync, persist before updating memory so observers see consistent state.
- **Avoid `setTimeout` for component coordination** - racy and fragile; use callbacks or effects.

## Component State & Storage

- Prefer **self-contained components** over utility functions + hook proliferation. A component that takes `workspaceId` and computes everything internally is better than one that requires 10 props drilled from parent hooks.
- Parent components own localStorage interactions; children announce intent only.
- **Never call `localStorage` directly** — always use `usePersistedState`/`readPersistedState`/`updatePersistedState` helpers. This includes inside `useCallback`, event handlers, and non-React functions. The helpers handle JSON parsing, error recovery, and cross-component sync.
- When a component needs to read persisted state it doesn't own (to avoid layout flash), use `readPersistedState` in `useState` initializer: `useState(() => readPersistedState(key, default))`.
- When multiple components need the same persisted value, use `usePersistedState` with identical keys and `{ listener: true }` for automatic cross-component sync.
- Avoid destructuring props in function signatures; access via `props.field` to keep rename-friendly code.

## Module Imports

- Use static `import` statements at the top; resolve circular dependencies by extracting shared modules, inverting dependencies, or using DI. Dynamic `await import()` is not an acceptable workaround.

## Workspace Identity

- Frontend must never synthesize workspace IDs (e.g., `${project}-${branch}` is forbidden). Backend operations that change IDs must return the value; always consume that response.

## IPC Type Boundary

1. IPC methods return backend types (`WorkspaceMetadata`, etc.), not ad-hoc objects.
2. Frontend may extend backend types with UI context (projectPath, branch, etc.).
3. Frontend constructs UI shapes from backend responses plus existing context (e.g., recommended trunk branch).
4. Never duplicate type definitions around the boundary—import shared types instead.

**Why:** single source of truth, clean separation, automatic propagation of backend changes, and no duplicate schemas.

## Debugging & Diagnostics

- `bun run debug ui-messages --workspace <name>` to inspect messages; add `--drop <n>` to skip recent entries. Workspace names live in `~/.mux/sessions/`.

## UX Guardrails

- Do not add UX flourishes (auto-dismiss, animations, tooltips, etc.) unless requested. Ship the simplest behavior that meets requirements.
- Enforce DRY: if you repeat code/strings, factor a shared helper/constant (search first; if cross-layer, move to `src/constants/` or `src/types/`).
- Hooks that detect a condition should handle it directly when they already have the data—avoid unnecessary callback hop chains.
- Every operation must have a keyboard shortcut, and UI controls with shortcuts should surface them in hover tooltips.

## Logging

- Use the `log` helper (`log.debug` for noisy output) for backend logging.

## Bug-Fixing Mindset

- Prefer fixes that simplify existing code; such simplifications often do not need new tests.
- When adding complexity, add or extend tests. If coverage requires new infrastructure, propose the harness and then add the tests there.
- When asked to reduce LoC, focus on simplifying production logic—not stripping comments, docs, or tests.

## Tool: status_set

- Set status url to the Pull Request once opened
