# AGENT INSTRUCTIONS

## Project Context

- Project is named `cmux`
- Electron + React desktop application for parallel agentic development
- UX should be fast, responsive, and intuitive

## Breaking Changes

The project is in early development phase. Breaking changes of minor features are expected. Strive
for backwards and forwards compatibility whenever possible on critical features. Users should be
able to upgrade, downgrade, upgrade between any two versions of cmux.
Do not worry about migrations for breakage confined to the scope of the PR.

## AI-Generated Content Attribution

When creating public operations (commits, PRs, issues), always include:

- 🤖 emoji in the title
- "_Generated with `cmux`_" in the body (if applicable)

This ensures transparency about AI-generated contributions.

## PR Management

**Prefer to reuse existing PRs** by force-pushing to the same branch, even if the branch name becomes irrelevant. Avoid closing and recreating PRs unnecessarily - PR spam clutters the repository history. **Never close PRs without explicit user instruction.** Always force-push to the existing branch instead of creating new PRs.

After submitting or updating PRs, **always check merge status**:

```bash
gh pr view <number> --json mergeable,mergeStateStatus | jq '.'
```

This is especially important with rapid development where branches quickly fall behind.

**Wait for PR checks to complete:**

```bash
./scripts/wait_pr_checks.sh <pr_number>
```

This script polls every 5 seconds and fails immediately on CI failure, bad merge status, or unresolved review comments.

**Key status values:**

- `mergeable: "MERGEABLE"` = No conflicts, can merge
- `mergeable: "CONFLICTING"` = Has conflicts, needs resolution
- `mergeStateStatus: "CLEAN"` = Ready to merge ✅
- `mergeStateStatus: "BLOCKED"` = Waiting for CI checks
- `mergeStateStatus: "BEHIND"` = Branch is behind base, rebase needed
- `mergeStateStatus: "DIRTY"` = Has conflicts

**If branch is behind:**

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease
```

### ⚠️ NEVER Auto-Merge PRs

**DO NOT** enable auto-merge (`gh pr merge --auto`) or merge PRs (`gh pr merge`) without **explicit user instruction**.

Reason: PRs may need human review, discussion, or additional changes based on review comments (e.g., Codex feedback). Always:

1. Submit the PR
2. Wait for checks to pass
3. Report PR status to user
4. **Wait for user to decide** whether to merge

Only merge if the user explicitly says "merge it" or similar.

### Writing PR Descriptions

Write PR bodies for **busy reviewers**. Be concise and avoid redundancy:

- **Each section should add new information** - Don't restate the same thing in different words
- **Structure emerges from content** - Some fixes need problem/solution/testing, others just need "what changed and why"
- **If it's obvious, omit it** - Problem obvious from solution? Don't state it. Solution obvious from problem? Skip to implementation details.
- **Avoid over-explaining** - Comprehensive testing checklists, multiple code examples, and detailed edge case lists make PRs harder to review. State the change and why it matters.

❌ **Bad** (redundant):

```
Problem: Markdown rendering is slow, causing 50ms tasks
Solution: Make markdown rendering faster
Impact: Reduces task time to <16ms
```

✅ **Good** (each section adds value):

```
ReactMarkdown was re-parsing content on every parent render because plugin arrays
were created fresh each time. Moved to module scope for stable references.

Verify with React DevTools Profiler - MarkdownCore should only re-render when content changes.
```

### PR Title Structure

Use these prefixes based on what best describes the PR:

- **perf:** (improvement to performance, no functionality changes)
- **refactor:** (improvement to codebase, no behavior changes)
- **fix:** (conforming behavior to user expectations)
- **feat:** (net new functionality)
- **ci:** (concerned with build process or CI)
- **bench:** (benchmarking infrastructure or Terminal-Bench integration)

Examples:

- `🤖 perf: cache markdown plugin arrays to avoid re-parsing`
- `🤖 refactor: extract IPC handlers to separate module`
- `🤖 fix: handle workspace rename edge cases`
- `🤖 feat: add keyboard shortcuts for workspace navigation`
- `🤖 ci: update wait_pr_checks script timeout`
- `🤖 bench: simplify timeout handling in terminal-bench integration`

## Project Structure

- `src/main.ts` - Main Electron process
- `src/preload.ts` - Preload script for IPC
- `src/App.tsx` - Main React component
- `src/config.ts` - Configuration management
- `~/.cmux/config.json` - User configuration file
- `~/.cmux/src/<project_name>/<branch>` - Local workspace directories (git worktrees)
- `~/.cmux/sessions/<workspace_id>/chat.jsonl` - Session chat histories

## Documentation Guidelines

**Free-floating markdown docs are not permitted.** Documentation must be organized. Do not create standalone markdown files in the project root or random locations, even for implementation summaries or planning documents - use the propose_plan tool or inline comments instead.

- **User-facing docs** → `./docs/` directory
  - **IMPORTANT**: Read `docs/README.md` first before writing user-facing documentation
  - User docs are built with mdbook and deployed to https://cmux.io
  - Must be added to `docs/SUMMARY.md` to appear in the docs
  - Use standard markdown + mermaid diagrams
- **Developer docs** → inline with the code its documenting as comments. Consider them notes as notes to future Assistants to understand the logic more quickly.
  **DO NOT** create standalone documentation files in the project root or random locations.
- **Test documentation** → inline comments in test files explaining complex test setup or edge cases, NOT separate README files.

**NEVER create markdown documentation files (README, guides, summaries, etc.) in the project root during feature development unless the user explicitly requests documentation.** Code + tests + inline comments are complete documentation.

### External API Docs

DO NOT visit https://sdk.vercel.ai/docs/ai-sdk-core. All of that content is already
in `/tmp/ai-sdk-docs/**.mdx`.

(Generate them with `./scripts/update_vercel_docs.sh` if they don't exist.)

### Documentation Guidelines

**Developer documentation should live inline with relevant code as comments.** The `docs/` directory contains user-facing documentation.

## Key Features

- Projects sidebar (left panel)
- Workspaces (local uses git worktrees, SSH uses remote git clones)
- Configuration persisted to `~/.cmux/config.json`

## Performance Patterns

**Avoid O(n) IPC calls from Frontend->Backend.** When displaying lists of items, fetch them in a single IPC call and process in the frontend. Never loop over items in the frontend making separate IPC calls for each.

## Package Manager

- **Using bun** - All dependencies are managed with bun (not npm)
- Use bun over npm whenever possible, including to:
  - Install dependencies: `bun install`
  - Add packages: `bun add <package>`
  - Run scripts: `bun run <script>`
  - etc.
- If you hit missing module/type errors locally or in CI, run `bun install` before diving into deeper debugging.

## Development Commands

This project uses **Make** as the primary build orchestrator. See `Makefile` for inline documentation.

**Primary commands (use Make):**

- `make dev` - Start development server (Vite + TypeScript watcher)
- `make start` - Build and start Electron app
- `make build` - Build the application (with parallelism)
- `make lint` - Run ESLint & typecheck
- `make lint-fix` - Run ESLint with --fix
- `make fmt` - Format all source files with Prettier
- `make fmt-check` - Check if files are formatted correctly
- `make typecheck` - Run TypeScript type checking
- `make test` - Run unit tests
- `make test-integration` - Run all tests (unit + integration)
- `make clean` - Clean build artifacts
- `make help` - Show all available targets

**Backwards compatibility:** Existing commands are available via `bun run` (e.g., `bun run dev` calls `make dev`). New commands will only be added to `Makefile`, not `package.json`.

## Refactoring

- When refactoring, use `git mv` to preserve file history instead of rewriting files from scratch

**⚠️ NEVER kill the running cmux process** - The main cmux instance is used for active development. Use `make test` or `make typecheck` to verify changes instead of starting the app in test workspaces.

## Testing

### Storybook

**Prefer full application stories over component-level stories** - Use `App.stories.tsx` to demonstrate features in realistic contexts rather than creating isolated component stories.

### Test-Driven Development (TDD)

**TDD is the preferred development style for agents.**

- **When asked to do TDD, write tests in the repository** - Create proper test files (e.g., `src/utils/foo.test.ts`) that run with `bun test` or `jest`, not temporary scripts in `/tmp`. Tests should be committed with the implementation.
- Prefer relocated complex logic into places where they're easily tested
  - E.g. pure functions in `utils` are easier to test than complex logic in a React component
- Strive for broad coverage with minimal tests
- Prefer testing large blocks of composite logic
  - Tests should be written with the end-user experience in mind
- **Good tests create conditions where the feature matters, then verify the difference.** Don't just test that requests succeed with a flag enabled—create the scenario where the flag changes the outcome (e.g., build history that exceeds limits, then verify flag prevents the error). Tests must prove the feature actually does something, not just that it doesn't break things.

### General Testing Guidelines

- Always run `make typecheck` after making changes to verify types (checks both main and renderer)
- **⚠️ CRITICAL: Unit tests MUST be colocated with the code they test** - Place `*.test.ts` files in the same directory as the implementation file (e.g., `src/utils/foo.test.ts` next to `src/utils/foo.ts`). Tests in `./tests/` are ONLY for integration/E2E tests that require complex setup.
- **Don't test simple mapping operations** - If the test just verifies the code does what it obviously does from reading it, skip the test.
  - ❌ **Bad**: `expect(REGISTRY.foo).toBe("bar")` - This just duplicates the implementation
  - ✅ **Good**: `expect(Object.keys(REGISTRY).length).toBeGreaterThan(0)` - Tests an invariant
  - ❌ **Bad**: `expect(isValid("foo")).toBe(true)` for every valid value - Duplicates implementation
  - ✅ **Good**: `expect(isValid("invalid")).toBe(false)` - Tests boundary/error cases
  - **Rule of thumb**: If changing the implementation requires changing the test in the same way, the test is probably useless
- **Avoid requiring manual setup in tests** - If every test needs the same initialization (provider setup, config, etc.), move that logic into the test helper functions. Tests should call one function and get a working environment, not repeat boilerplate setup steps.
- Strive to decompose complex logic away from the components and into `.src/utils/`
  - utils should be either pure functions or easily isolated (e.g. if they operate on the FS they accept
    a path). Testing them should not require complex mocks or setup.
- **Integration tests:**
  - **⚠️ IMPORTANT: Use `bun x jest` to run tests in the `tests/` folder** - Integration tests use Jest (not bun test), so you must run them with `bun x jest` or `TEST_INTEGRATION=1 bun x jest`
  - Run specific integration test: `TEST_INTEGRATION=1 bun x jest tests/ipcMain/sendMessage.test.ts -t "test name pattern"`
  - Run all integration tests: `TEST_INTEGRATION=1 bun x jest tests` (~35 seconds, runs 40 tests)
  - Unit tests in `src/` use bun test: `bun test src/path/to/file.test.ts`
  - **⚠️ Running `tests/ipcMain` locally takes a very long time.** Prefer running specific test files or use `-t` to filter to specific tests.
  - **Performance**: Tests use `test.concurrent()` to run in parallel within each file
  - **NEVER bypass IPC in integration tests** - Integration tests must use the real IPC communication paths (e.g., `mockIpcRenderer.invoke()`) even when it's harder. Directly accessing services (HistoryService, PartialService, etc.) or manipulating config/state directly bypasses the integration layer and defeats the purpose of the test.

  **Examples of bypassing IPC (DON'T DO THIS):**

  ```typescript
  // ❌ BAD - Directly manipulating config
  const config = env.config.loadConfigOrDefault();
  config.projects.set(projectPath, { path: projectPath, workspaces: [] });
  env.config.saveConfig(config);
  ```

// ❌ BAD - Directly accessing services
const history = await env.historyService.getHistory(workspaceId);
await env.historyService.appendToHistory(workspaceId, message);

````

**Correct approach (DO THIS):**

```typescript
// ✅ GOOD - Use IPC to save config
await env.mockIpcRenderer.invoke(IPC_CHANNELS.CONFIG_SAVE, {
  projects: Array.from(projectsConfig.projects.entries()),
});

// ✅ GOOD - Use IPC to interact with services
await env.mockIpcRenderer.invoke(IPC_CHANNELS.HISTORY_GET, workspaceId);
await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, projectPath, branchName);
````

**Acceptable exceptions:**

- Reading context (like `env.config.loadConfigOrDefault()`) to prepare IPC call parameters
- Verifying filesystem state (like checking if files exist) after IPC operations complete
- Loading existing data to avoid expensive API calls in test setup

If IPC is hard to test, fix the test infrastructure or IPC layer, don't work around it by bypassing IPC.

## Command Palette (Cmd+Shift+P)

- Open with `Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows/Linux.
- Quick toggle sidebar is `Cmd+P` / `Ctrl+P`.
- Palette includes workspace switching/creation, navigation, chat utils, mode/model, projects, and slash-command prefixes:
  - `/` shows slash command suggestions (select to insert into Chat input).
  - `>` filters to actions only.

## Styling

- Colors are centralized as CSS variables in `src/styles/colors.tsx`
- Use CSS variables (e.g., `var(--color-plan-mode)`) instead of hardcoded colors
- Fonts are centralized as CSS variables in `src/styles/fonts.tsx`

## TypeScript Best Practices

- **Avoid `as any` in all contexts** - Never use `as any` casts. Instead:
  - Use proper type narrowing with discriminated unions
  - Leverage TypeScript's type guards and the compiler's type checking
  - Import and reuse existing types from dependencies rather than creating anonymous clones
  - If a type is truly complex, create a proper type definition or interface

- **Use `Record<EnumType, ValueType>` for exhaustive mappings** - When mapping enum values to strings, colors, or other values, use `Record` types instead of switch statements or if/else chains. This ensures TypeScript catches missing or invalid cases at compile time.

  ```typescript
  // ✅ Good - TypeScript ensures all modes are handled
  const MODE_COLORS: Record<UIPermissionMode, string> = {
    plan: "var(--color-plan-mode)",
    edit: "var(--color-edit-mode)",
  };

  // ❌ Avoid - Can miss cases, typos won't be caught
  switch (mode) {
    case "plan":
      return "blue";
    case "edits":
      return "green"; // Typo won't be caught!
  }
  ```

- **Leverage TypeScript's utility types for UI-specific data** - Use `Omit`, `Pick`, and other utility types to create UI-specific versions of backend types. This prevents unnecessary re-renders and clearly separates concerns.

  ```typescript
  // Backend type with all fields
  export interface WorkspaceMetadata {
    id: string;
    projectName: string;
    permissionMode: UIPermissionMode;
    nextSequenceNumber: number; // Backend bookkeeping
  }

  // UI type excludes backend-only fields
  export type WorkspaceMetadataUI = Omit<WorkspaceMetadata, "nextSequenceNumber">;
  ```

  This pattern ensures:
  - UI components don't re-render on backend-only changes
  - Clear separation between UI and backend concerns
  - Type safety - compiler catches if you try to access excluded fields
  - Self-documenting code - types clearly show what data UI needs

- **Prefer type-driven development** - Let TypeScript guide your architecture. When types become complex or you need many runtime checks, it often indicates a design issue. Simplify by:
  - Creating focused types for specific contexts (UI vs backend)
  - Using discriminated unions for state variations
  - Leveraging the compiler to catch errors at build time

- **Use `using` for leakable system resources** - Always use explicit resource management (`using` declarations) for resources that need cleanup such as child processes, file handles, database connections, etc. This ensures proper cleanup even when errors occur.

  ```typescript
  // ✅ Good - Process is automatically cleaned up
  using process = createDisposableProcess(spawn("command"));
  const output = await readFromProcess(process);
  // process.kill() called automatically when going out of scope

  // ❌ Avoid - Process may leak if error occurs before cleanup
  const process = spawn("command");
  const output = await readFromProcess(process);
  process.kill(); // May never be reached if error thrown
  ```

- This pattern maximizes type safety and prevents runtime errors from typos or missing cases

- **Centralize magic constants** - Define in `src/constants/` and import everywhere. Never duplicate numbers/strings across backend, UI, tests, and schema descriptions.

## Component State Management

**For per-operation state tied to async workflows, parent components should own all localStorage operations.** Child components should notify parents of user intent without manipulating storage directly, preventing bugs from stale or orphaned state across component lifecycles.

## Module Imports

- **NEVER use dynamic imports** - Always use static `import` statements at the top of files. Dynamic imports (`await import()`) are a code smell that indicates improper module structure.

  ```typescript
  // ❌ BAD - Dynamic import hides circular dependency
  const { getTokenizerForModel } = await import("../utils/tokenizer");

  // ✅ GOOD - Static import at top of file
  import { getTokenizerForModel } from "../utils/tokenizer";
  ```

- **If you encounter circular dependencies** - Restructure the code to eliminate them. Common solutions:
  - Extract shared types/interfaces into a separate file
  - Move shared utilities into a common module
  - Invert the dependency relationship
  - Use dependency injection instead of direct imports

  Dynamic imports are NOT an acceptable workaround for circular dependencies.

## Workspace IDs - NEVER Construct in Frontend

**CRITICAL: Workspace IDs must NEVER be constructed in the frontend.** This is a dangerous form of duplication that makes the codebase brittle.

- ❌ **BAD** - Constructing workspace ID from parts:

  ```typescript
  const newWorkspaceId = `${projectName}-${newName}`; // WRONG!
  ```

- ✅ **GOOD** - Get workspace ID from backend:
  ```typescript
  const result = await window.api.workspace.rename(workspaceId, newName);
  if (result.success) {
    const newWorkspaceId = result.data.newWorkspaceId; // Backend provides it
  }
  ```

**Why this matters:**

- Workspace ID format is a backend implementation detail
- If the backend changes ID format, frontend breaks silently
- Creates multiple sources of truth
- Leads to subtle bugs and inconsistencies

**Always:**

- Backend operations that change workspace IDs must return the new ID
- Frontend must use the returned ID, never construct it
- Backend is the single source of truth for workspace identity

## IPC Type Boundaries

**Backend types vs Frontend types - Keep them separate.**

The IPC layer is the boundary between backend and frontend. Follow these rules to maintain clean separation:

### Rules:

1. **IPC methods should return backend types** - Use `WorkspaceMetadata`, not custom inline types

   ```typescript
   // ✅ GOOD - Returns backend type
   create(): Promise<{ success: true; metadata: WorkspaceMetadata } | { success: false; error: string }>

   // ❌ BAD - Duplicates type definition inline
   create(): Promise<{ success: true; workspace: { workspaceId: string; projectName: string; ... } }>
   ```

2. **Frontend types extend backend types with UI context** - Frontend has information backend doesn't

   ```typescript
   // Backend type (no projectPath - backend doesn't need it)
   interface WorkspaceMetadata {
     id: string;
     projectName: string;
     workspacePath: string;
   }

   // Frontend type (adds projectPath and branch for UI)
   interface WorkspaceSelection extends WorkspaceMetadata {
     projectPath: string; // Frontend initiated the call, so it has this
     branch: string; // Frontend tracks this for display
     workspaceId: string; // Alias for 'id' to match UI conventions
   }
   ```

3. **Frontend constructs UI types from backend types + local context**

   ```typescript
   // ✅ GOOD - Frontend combines backend data with context it already has
   const { recommendedTrunk } = await window.api.projects.listBranches(projectPath);
   const trunkBranch = recommendedTrunk ?? "main";
   const result = await window.api.workspace.create(projectPath, branchName, trunkBranch);
   if (result.success) {
     setSelectedWorkspace({
       ...result.metadata,
       projectPath, // Frontend already had this
       branch: branchName, // Frontend already had this
       workspaceId: result.metadata.id,
     });
   }

   // ❌ BAD - Backend returns frontend-specific data
   const { recommendedTrunk } = await window.api.projects.listBranches(projectPath);
   const trunkBranch = recommendedTrunk ?? "main";
   const result = await window.api.workspace.create(projectPath, branchName, trunkBranch);
   if (result.success) {
     setSelectedWorkspace(result.workspace); // Backend shouldn't know about WorkspaceSelection
   }
   ```

4. **Never duplicate type definitions in IPC layer** - Always import and use existing types

### Why this matters:

- **Single source of truth** - Backend types are defined once
- **Clean boundaries** - Backend doesn't know about UI concerns
- **Type safety** - Changes to backend types propagate to IPC automatically
- **Prevents duplication** - No need to keep inline types in sync with source types

## Debugging

- `bun run debug ui-messages --workspace <workspace-name>` - Show UI messages for a workspace
- `bun run debug ui-messages --workspace <workspace-name> --drop <n>` - Show messages with last n dropped
- Workspace names can be found in `~/.cmux/sessions/`

## UX Guidelines

- **DO NOT add UX complexity without permission** - Keep interfaces simple and predictable. Do not add features like auto-dismiss, animations, tooltips, or other UX enhancements unless explicitly requested by the user.

  Example of adding unwanted complexity:

  ```typescript
  // ❌ BAD - Added auto-dismiss without being asked
  useEffect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => {
        setErrorMessage(null);
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [errorMessage]);
  ```

  Instead, implement the simplest solution that meets the requirement.

## DRY

Notice when you've made the same change many times, refactor to create a shared function
or component, update all the duplicated code, and then continue on with the original work.
When repeating string literals (especially in error messages, UI text, or system instructions), extract them to named constants in a relevant constants/utils file - never define the same string literal multiple times across files.
Before defining a constant, search the codebase to see if it already exists and import it instead.
If a constant exists in a layer-specific location (`services/`, `utils/main/`) but is needed across layers, move it to a shared location (`src/constants/`, `src/types/`) rather than duplicating it.

**Avoid unnecessary callback indirection**: If a hook detects a condition and has access to all data needed to handle it, let it handle the action directly rather than passing callbacks up to parent components. Keep hooks self-contained when possible.

## UX Considerations

- For every operation in the frontend, there should be a keyboard shortcut.
- Buttons, widgets, etc. that have a keybind should display a tooltip for it during hover.

## Logging

In the backend, use the `log` class from `log.ts` to log messages. Particularly spammy messages
should go through `log.debug()`.

## Solving Bugs

- When solving a new bug, consider whether there's a solution that simplifies the overall codebase
  _to_ simplify the bug.
- If you're fixing via simplifcation, a new test case is generally not necessary.
- If fixing through additional complexity, add a test case if an existing convenient harness exists.
  - Otherwise if creating complexity, propose a new test harness to contain the new tests.

## Mode: Exec

If a user requests `wait_pr_checks`, treat it as a directive to keep running that process and address failures continuously. Do not return to the user until the checks succeed or you encounter a blocker you cannot resolve alone. This mode signals that the user expects persistent execution without further prompting.

If static checks fail remotely, reproduce the error locally with `make static-check` before responding. If formatting issues are flagged, run `make fmt` to fix them before retrying CI.

If any test or check fails in CI, see if you can reproduce the failure locally
before returning to wait_pr_checks. Try to run the minimal set of tests to reproduce the failure. This is in an effort to move fast. Take note of how long commands take to run and adjust your workflow to minimize time spent waiting.

## Mode: Plan

In Plan Mode, attach a net LoC estimate to recommended approach(es). This estimate should be
focussed on product code changes, not test code changes.
