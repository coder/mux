---
title: AGENTS.md
description: Agent instructions for AI assistants working on the Mux codebase
---

**Prime directive:** keep edits minimal and token-efficient—say only what conveys actionable signal.

## Project Snapshot

- `mux`: Electron + React desktop app for parallel agent workflows; UX must be fast, responsive, predictable.
- Minor breaking changes are expected, but critical flows must allow upgrade↔downgrade without friction; skip migrations when breakage is tightly scoped.
- **Before creating or updating any PR, commit, or public issue**, you **MUST** read the `pull-requests` skill (`agent_skill_read`) for attribution footer requirements and workflow conventions. Do not skip this step.

## External Submissions

- **Do not submit updates to the Terminal-Bench leaderboard repo directly.** Only provide the user with commands they can run themselves.

## Repo Reference

- Core files: `src/main.ts`, `src/preload.ts`, `src/App.tsx`, `src/config.ts`.
- Up-to-date model names: see `src/common/knownModels.ts` for current provider model IDs.
- Persistent data: `~/.mux/config.json`, `~/.mux/src/<project>/<branch>` (worktrees), `~/.mux/sessions/<workspace>/chat.jsonl`.

## Documentation Rules

- No free-floating Markdown. User docs live in `docs/` (read `docs/README.md`, add pages to `docs.json` navigation, use standard Markdown + mermaid). Developer notes belong inline as comments.
  - Exception: the `rfc` folder contains human-written RFCs for implementation planning.
- For planning artifacts, use the `propose_plan` tool or inline comments instead of ad-hoc docs.
- Do not add new root-level docs without explicit request; during feature work rely on code + tests + inline comments.
- External API docs already live inside `/tmp/ai-sdk-docs/**.mdx`; never browse `https://sdk.vercel.ai/docs/ai-sdk-core` directly.

### Code Comments

- When delivering a user's request, leave their rationale in the code as comments.
- Generally, prefer code comments that explain the "why" behind a change.
- Still explain the "what" if the code is opaque, surprising, confusing, etc.

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
- `.mux/tool_env` is sourced before every `bash` tool call. Use `run_and_report <step_name> <command...>` when running multiple validation steps in one call.
- Do not pipe/redirect/wrap `run_and_report` output; keep helper markers intact so Mux can show clean step status.
- `./scripts/wait_pr_ready.sh <pr_number>` is the preferred tail-end helper after local validation and after you've exhausted useful local work.
- `./scripts/wait_pr_checks.sh <pr_number>` is the checks watcher; `wait_pr_ready.sh` must execute `wait_pr_checks.sh --once` on each loop iteration.
- `./scripts/wait_pr_codex.sh <pr_number>` is the Codex gate used by `wait_pr_ready.sh`.

## PR Workflow (Codex)

- If a PR has Codex review comments, address + resolve them, then re-request review by commenting `@codex review` on the PR.
- Prefer `gh` CLI for GitHub interactions over manual web/curl flows.
- In Orchestrator mode, delegate implementation/verification commands to `exec` or `explore` sub-agents and integrate their patches; do not bypass delegation with direct local edits.
- In Orchestrator mode, route higher-complexity implementation tasks to `plan` sub-agents so they can research and produce a precise plan before auto-handoff to implementation.

- **PR creation gate:** Do **not** open/create a pull request unless the user explicitly asks (e.g., "open a PR", "create PR", "submit this"). By default, complete local validation, commit/push branch updates as requested, and let the user review before deciding whether to open a PR.

> PR readiness is mandatory. You MUST keep iterating until the PR is fully ready.
> A PR is fully ready only when: (1) Codex confirms approval (thumbs-up reaction on the PR description or an approval comment like "Didn't find any major issues"), (2) all Codex review threads are resolved, and (3) all required CI checks pass.
> You MUST NOT report success or stop the loop before these conditions are met.

When a PR exists, you MUST remain in this loop until the PR is fully ready:

1. Push your latest fixes.
2. Run local validation (`make static-check` and targeted tests as needed); in Orchestrator mode, delegate command execution to sub-agents.
3. Request review with `@codex review`.
4. Run `./scripts/wait_pr_ready.sh <pr_number>` (which must execute `./scripts/wait_pr_checks.sh <pr_number> --once` while checks are pending).
5. If Codex leaves comments, address them (delegate fixes in Orchestrator mode), resolve threads with `./scripts/resolve_pr_comment.sh <thread_id>`, push, and repeat.
6. If checks/mergeability fail, fix issues locally (delegate fixes in Orchestrator mode), push, and repeat.

The only early-stop exception is when the reviewer is clearly misunderstanding the intended change and further churn would be counterproductive. In that case, leave a clarifying PR comment and pause for human direction.

## Testing: HistoryService

HistoryService is pure local disk I/O with a single dependency (`getSessionDir`). **Always use a real instance** via `createTestHistoryService()` (`src/node/services/testHistoryService.ts`) rather than mocking.

- Partial message lifecycle (`readPartial` / `writePartial` / `deletePartial` / `commitPartial`) is part of HistoryService; there is no separate PartialService.
- For pre-seeded data: call `historyService.appendToHistory()` in `beforeEach`
- For error injection: use real instance + `spyOn(historyService, "method").mockRejectedValueOnce(...)`
- For call tracking: `spyOn(historyService, "method")` without `mockImplementation` — real impl runs, calls are recorded
- For assertions: read history back with `getHistoryFromLatestBoundary()` or `getLastMessages()` instead of checking mock calls

## Refactoring & Runtime Etiquette

- Use `git mv` to retain history when moving files.

## Self-Healing & Crash Resilience

- Prefer **self-healing** behavior: if corrupted or invalid data exists in persisted state (e.g., `chat.jsonl`), the system should sanitize or filter it at load/request time rather than failing permanently.
- Never let a single malformed line in history brick a workspace—apply defensive filtering in request-building paths so the user can continue working.
- When streaming crashes, any incomplete state committed to disk should either be repairable on next load or excluded from provider requests to avoid API validation errors.
- **Startup-time initialization must never crash the app.** Wrap in try-catch, use timeouts, fall back silently.

## Command Palette & UI Access

- Open palette with `Cmd+Shift+P` (mac) / `Ctrl+Shift+P` (win/linux) / `F4`; quick toggle via `Cmd+P` / `Ctrl+P`.
- Palette covers workspace mgmt, navigation, chat utils, mode/model switches, slash commands (`/` for suggestions, `>` for actions).

## Styling

- Never use emoji characters as UI icons or status indicators; emoji rendering varies across platforms and fonts.
- Prefer SVG icons (usually from `lucide-react`) or shared icon components under `src/browser/components/icons/`.
- For tool call headers, use `ToolIcon` from `src/browser/components/tools/shared/ToolPrimitives.tsx`.
- If a tool/agent provides an emoji string (e.g., `status_set` or `displayStatus`), render via `EmojiIcon` (`src/browser/components/icons/EmojiIcon.tsx`) instead of rendering the emoji.
- If a new emoji appears in tool output, extend `EmojiIcon` to map it to an SVG icon.
- Colors defined in `src/browser/styles/globals.css` (`:root @theme` block). Reference via CSS variables (e.g., `var(--color-plan-mode)`), never hardcode hex values.

## Security: Renderer HTML & XSS

- Treat repo-controlled strings (file paths, diff content, branch names, commit messages) as attacker-controlled input.
- Never render attacker-controlled data through `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, or `insertAdjacentHTML`.
- Prefer React element trees for highlighting (split + `<mark>` nodes) so React escaping stays in effect.
- If raw HTML/SVG rendering is unavoidable (e.g., Shiki/Mermaid), require explicit sanitization/hardening and document the trust boundary with a `SECURITY AUDIT` comment at the sink.

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
- **Keyboard event propagation** - React's `e.stopPropagation()` only stops synthetic event bubbling; native `window` listeners still fire. Escape-to-interrupt is **safe-by-default** in editable elements (`<input>`, `<textarea>`, `contentEditable`) — the stream interrupt handler ignores Escape unless the element opts in via `data-escape-interrupts-stream`. Use `stopKeyboardPropagation(e)` from `@/browser/utils/events` when you need to block other global handlers (or non-editable UI) from seeing the event.

## Tool Schema Conventions

- **Use `.nullish()` for optional tool input parameters** — never `.optional()` alone. OpenAI's Responses API normalizes tool schemas into strict mode, which forces every field into `required` and expects optional fields to accept `null`. `.nullish()` (= `.optional().nullable()`) satisfies strict-mode providers (OpenAI) while remaining compatible with non-strict providers (Anthropic, Google). See the module doc comment in `src/common/utils/tools/toolDefinitions.ts` for details.
- Implementation handlers should use `!= null` (loose equality) instead of `!== undefined` to treat both `null` and `undefined` as "not provided".
- This applies only to tool **input** schemas (parameters the model provides), not to tool **output/result** schemas (constructed by our backend).

## Component State & Storage

- Prefer **self-contained components** over utility functions + hook proliferation. A component that takes `workspaceId` and computes everything internally is better than one that requires 10 props drilled from parent hooks.
- **Colocate subscriptions with consumers** — Don't pass frequently-updating values (streaming stats, live costs, timers) as props through intermediate components. Instead, have the leaf component that displays the value subscribe directly. This prevents re-renders from cascading through expensive sibling subtrees (e.g., terminal). See `CostsTabLabel`/`StatsTabLabel` for examples.
- Parent components own localStorage interactions; children announce intent only.
- **Never call `localStorage` directly** — always use `usePersistedState`/`readPersistedState`/`updatePersistedState` helpers. This includes inside `useCallback`, event handlers, and non-React functions. The helpers handle JSON parsing, error recovery, and cross-component sync.
- When a component needs to read persisted state it doesn't own (to avoid layout flash), use `readPersistedState` in `useState` initializer: `useState(() => readPersistedState(key, default))`.
- When multiple components need the same persisted value, use `usePersistedState` with identical keys and `{ listener: true }` for automatic cross-component sync.
- Avoid destructuring props in function signatures; access via `props.field` to keep rename-friendly code.

## Module Imports

- Use static `import` statements at the top; resolve circular dependencies by extracting shared modules, inverting dependencies, or using DI. Dynamic `await import()` is not an acceptable workaround.

## Workspace Identity

- Frontend must never synthesize workspace IDs (e.g., `${project}-${branch}` is forbidden). Backend operations that change IDs must return the value; always consume that response.

## IPC

### Typing

1. IPC methods return backend types (`WorkspaceMetadata`, etc.), not ad-hoc objects.
2. Frontend may extend backend types with UI context (projectPath, branch, etc.).
3. Frontend constructs UI shapes from backend responses plus existing context (e.g., recommended trunk branch).
4. Never duplicate type definitions around the boundary—import shared types instead.

**Why:** single source of truth, clean separation, automatic propagation of backend changes, and no duplicate schemas.

### Compatibility

It is safe to assume that the frontend and backend of the IPC are always in sync.
Freely make breaking changes, and reorganize / cleanup IPC as needed.

## Debugging & Diagnostics

- `bun run debug ui-messages --workspace <name>` to inspect messages; add `--drop <n>` to skip recent entries. Workspace names live in `~/.mux/sessions/`.

## UX Guardrails

- Do not add UX flourishes (auto-dismiss, animations, tooltips, etc.) unless requested. Ship the simplest behavior that meets requirements.
- Enforce DRY: if you repeat code/strings, factor a shared helper/constant (search first; if cross-layer, move to `src/constants/` or `src/types/`).
- Hooks that detect a condition should handle it directly when they already have the data—avoid unnecessary callback hop chains.
- Every operation must have a keyboard shortcut. The keyboard shortcut should not be visible on mobile views.

## Logging

- Use the `log` helper (`log.debug` for noisy output) for backend logging.

## Bug-Fixing Mindset

- Avoid timing-based coordination (e.g., sleep/grace timers) when deterministic signals exist; prefer awaiting explicit completion/exit signals.
- When asked to reduce LoC, focus on simplifying production logic—not stripping comments, docs, or tests.

## UI Component Testability (tests/ui)

- **Radix Popover portals don't work in happy-dom** — content renders to `document.body` via portal but happy-dom doesn't support this properly. Popover content won't appear in tests.
- **Use conditional rendering for testability:** Components like `AgentModePicker` use `{isOpen && <div>...}` instead of Radix Portal. This renders inline and works in happy-dom.
- When adding new dropdown/popover components that need tests/ui coverage, prefer the conditional rendering pattern over Radix Portal.
- E2E tests (tests/e2e) work with Radix but are slow (~2min startup); reserve for scenarios that truly need real Electron.
- Only use `validateApiKeys()` in tests that actually make AI API calls.

## Tool: status_set

- Set status url to the Pull Request once opened

## GitHub

Many tasks involve reading and writing from GitHub, prefer the `gh` CLI over web search and manual curl requests when helping the User.
