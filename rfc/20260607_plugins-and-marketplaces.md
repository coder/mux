---
author: dcieslak19973
date: 2026-06-07
---

# Plugins and Marketplaces for Mux

Status: Draft

## Stakeholders

- [ ] Product Lead:
- [ ] Engineering DRI:
- [ ] CTO:
- [ ] Skills/Extensibility reviewer:
- [ ] Runtime/trust & security reviewer:

## Problem Statement

Mux supports the individual extension primitives — [agentskills.io](https://agentskills.io)-compliant skills, file-based tool hooks, MCP servers, and built-in/custom agents — but each is configured independently. There is no way to package a related set of them together, or to distribute, install, and version that set as a unit. Sharing a coherent setup across machines or teammates means reproducing each piece separately.

Meanwhile the ecosystem has converged on a clear answer: a **plugin** is a declarative bundle of those primitives behind a small manifest, distributed through a **marketplace** (typically a git repo). Claude Code and OpenAI Codex now share nearly the same manifest shape; opencode took a different (code-module + npm) route. This RFC proposes a Mux plugin + marketplace system that (a) reuses Mux's existing primitives, (b) is deliberately compatible with the Claude Code / Codex convention so the existing plugin ecosystem is largely portable, and (c) uses Mux's existing trust/runtime model as a security differentiator.

## Glossary

- **Plugin**: a versioned, installable bundle of Mux extension primitives (skills, hooks, MCP servers, agents, commands) described by a manifest.
- **Plugin Manifest**: the `.agents/plugin.json` file (vendor-neutral) declaring a plugin's identity and components.
- **Marketplace**: an index (git repo, local path, or registry) listing installable plugins and their sources, registered under `.agents/plugins/marketplace.json`.
- **Source**: where a plugin's bytes come from — git/GitHub, local path, or npm.
- **Install Cache**: the on-disk location where resolved plugin versions live (`~/.mux/plugins/cache/...`).
- **Plugin Trust**: the per-plugin grant a user gives before code-bearing components (hooks, MCP servers) are allowed to run.
- **Component**: one primitive contributed by a plugin (a skill, a hook, an MCP server, an agent, a command).

## Background: what Mux has today

| Primitive          | Mux today                                                                                                   | Where                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Skills             | agentskills.io-compliant `SKILL.md`, project/global/built-in scopes, progressive disclosure                 | `agentSkills/parseSkillMarkdown.ts`, `AgentSkillFrontmatterSchema` |
| Skills registry    | searchable remote catalog (`skills.sh`) with install counts                                                 | `tools/skillsCatalogFetch.ts`                                      |
| Hooks              | file scripts `.mux/tool_pre`, `tool_post`, `tool_env`, init hooks; exit-code based; project→user resolution | `docs/hooks/*`                                                     |
| MCP servers        | per-workspace MCP config + lifecycle                                                                        | `mcpConfigService`, `mcpServerManager`                             |
| Agents / subagents | built-in + custom agents, `Task` delegation                                                                 | `builtinAgents`, `taskService`                                     |
| Slash commands     | ACP-style commands                                                                                          | ACP integration                                                    |
| Trust / policy     | runtime trust + policy gating                                                                               | `policyService`, runtime trust helpers                             |

The missing layer is the **bundle + distribution + trust lifecycle** that ties these together. Notably, a skills-only "marketplace" (`skills.sh`) already exists — this RFC generalizes it rather than starting from scratch.

## Prior art: how Claude Code, Codex CLI, and opencode differ

This is the core comparison the design must account for. **Claude Code and Codex are nearly the same declarative system; opencode is fundamentally different.**

### Summary

| Dimension        | Claude Code                                                                           | Codex CLI                                                                   | opencode                                                  |
| ---------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| Plugin shape     | Declarative manifest                                                                  | Declarative manifest                                                        | **Code module** (JS/TS fn returning hooks)                |
| Manifest         | `.claude-plugin/plugin.json`                                                          | `.codex-plugin/plugin.json`                                                 | none                                                      |
| Components       | skills, agents, commands, hooks, MCP, **LSP, monitors, themes, output-styles**        | skills, hooks, MCP, **apps/connectors**                                     | tools (code), + filesystem `command/`, `agent/`, `skill/` |
| Hooks format     | `hooks/hooks.json`, event-keyed, `{type:"command"}`, matchers, JSON decision protocol | **identical** `hooks/hooks.json`                                            | code callbacks on a fine-grained event bus                |
| Hook env         | `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`                                      | `${PLUGIN_ROOT}`, `${PLUGIN_DATA}` **and** `${CLAUDE_PLUGIN_ROOT}` (compat) | n/a (in-process)                                          |
| Marketplace file | `.claude-plugin/marketplace.json`                                                     | `.agents/plugins/marketplace.json` (vendor-neutral dir)                     | none (uses npm)                                           |
| Official store   | community + managed                                                                   | **official curated Plugin Directory** (App/CLI/IDE)                         | none                                                      |
| Source backends  | **git, GitHub, GitLab, npm, local**                                                   | git, local (self-serve publish pending)                                     | **npm, local**                                            |
| Versioning       | `plugin.json` version or git SHA fallback; pinning; deps with semver                  | semver in manifest                                                          | npm semver                                                |
| Enable/disable   | `defaultEnabled`, `claude plugin enable/disable`                                      | `enabled=false` in `config.toml`                                            | presence in `opencode.json`                               |
| Install cache    | `~/.claude/...`, 7-day orphan GC                                                      | `~/.codex/plugins/cache/$MKT/$PLUGIN/$VERSION/`                             | `~/.cache/opencode/node_modules/`                         |
| Trust model      | managed/blocked marketplaces, `strictKnownMarketplaces` (enterprise)                  | per-plugin `policy` (`installation`, `authentication`), connect-on-install  | runs arbitrary npm code at startup (weakest)              |

### Differences that matter for our design

1. **Manifest convergence (Claude Code ≈ Codex).** Both use `<vendor>-plugin/plugin.json` with the same component set and an _identical_ `hooks/hooks.json` schema. Codex even exports `CLAUDE_PLUGIN_ROOT` for compatibility and puts its marketplace under a vendor-neutral `.agents/` directory. **There is a de-facto cross-tool plugin convention**, and skills inside it are already standardized via agentskills.io.
2. **Codex-only: `apps`/connectors and a rich `interface{}` block** (display name, icons, screenshots, categories, starter prompts) for an app-store UX, plus a per-plugin `policy` object. Claude Code-only: **LSP servers, monitors, themes, output-styles** as plugin components.
3. **opencode is the outlier.** Plugins are executable modules (no manifest), distributed via **npm**, with **no first-party marketplace** (community indexes like `opencode-marketplace`, `oh-my-opencode`). Its strength is the **richest runtime event bus** (`tool.execute.before/after`, `session.*`, `permission.asked`, `file.edited`, `lsp.*`, …). Its weakness is distribution fragmentation and that it runs third-party code in-process at startup.
4. **npm is supported by both Claude Code and opencode** (Codex leans git). Any Mux design should treat npm as a first-class source, not an afterthought.
5. **Trust is unsolved across the board.** Claude Code leans on enterprise marketplace allow/block lists; Codex on per-plugin install/auth policy; opencode effectively trusts everything it installs. None has a strong per-plugin runtime sandbox. **Mux's `policyService` + runtime trust is a genuine differentiation opportunity here.**

## Goals

1. Define a **declarative, vendor-neutral plugin manifest** (`.agents/plugin.json`) that bundles skills, hooks, MCP servers, agents, and commands, mapping each onto Mux's existing loaders.
2. Be **import-compatible with the Claude Code / Codex convention** (same component layout, accept `.claude-plugin`/`.codex-plugin` manifests, `hooks/hooks.json` schema, expose `${AGENT_PLUGIN_ROOT}` + `${CLAUDE_PLUGIN_ROOT}`), so existing plugins mostly "just work."
3. Define a **marketplace format** (`marketplace.json`) with **git/GitHub, local, and npm** sources, generalizing the existing `skills.sh` catalog rather than replacing it.
4. Provide an **install/enable/version/update/uninstall lifecycle** with an install cache and pinning.
5. Make **trust explicit**: code-bearing components (hooks, MCP servers) are disabled until the user grants per-plugin trust, enforced through `policyService`.
6. Surface plugins in Mux's existing UI (command palette, settings) and as discoverable like skills.

## Non-goals

1. Not building a hosted Mux plugin directory/registry in v1 (git + local + npm sources only; the existing catalog API can index later).
2. Not adopting opencode's executable-module plugin model — Mux plugins are declarative; code lives in hooks/scripts/MCP servers, not in a plugin entrypoint loaded in-process.
3. Not implementing Claude Code's LSP/monitors/themes/output-styles plugin components in v1.
4. Not implementing Codex's `apps`/connector OAuth model in v1 (MCP covers most of it).
5. Not changing the SKILL.md format — plugins reuse agentskills.io skills as-is.

## Proposed design

### Plugin package format

```
my-plugin/
├── .agents/
│   └── plugin.json          # required manifest (vendor-neutral)
├── skills/                  # agentskills.io skill folders (reuse existing loader)
│   └── <skill-name>/SKILL.md
├── agents/                  # custom agent markdown
├── commands/                # slash commands
├── hooks/
│   └── hooks.json           # event-keyed hooks (Claude Code/Codex shape)
├── .mcp.json                # MCP server definitions
└── assets/                  # icons, etc.
```

The manifest lives under the vendor-neutral `.agents/` directory (the same namespace Codex uses for marketplace registration) rather than a `mux`-branded folder, so a plugin repo is not tied to any one agent.

`plugin.json` (superset-compatible with Claude Code / Codex):

```jsonc
{
  "name": "postgres-toolkit", // kebab-case, unique id
  "version": "1.2.0", // semver; git SHA fallback if omitted
  "description": "...",
  "author": { "name": "...", "url": "..." },
  "repository": "https://github.com/...",
  "license": "Apache-2.0",
  "keywords": ["db", "sql"],
  "defaultEnabled": false, // plugins with code default OFF (see Trust)
  "dependencies": [{ "name": "secrets-vault", "version": "~2.1.0" }],

  // component pointers (all optional; sensible default paths)
  "skills": "./skills/",
  "agents": "./agents/",
  "commands": "./commands/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
}
```

**Compatibility:** the loader resolves the manifest in priority order — `.agents/plugin.json` (canonical), then `.claude-plugin/plugin.json`, then `.codex-plugin/plugin.json` — and recognizes Codex's `interface{}` block (used only for nicer display when present). This makes the bulk of the existing Claude Code / Codex ecosystem installable in Mux unchanged while keeping the native authoring path vendor-neutral.

### Component mapping onto existing Mux systems

| Manifest component | Mux loader it feeds                                   | Notes                                                                                                    |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `skills/`          | existing agent-skill discovery (`parseSkillMarkdown`) | add a `plugin` scope alongside project/global/built-in; precedence: project > plugin > global > built-in |
| `agents/`          | built-in/custom agent registry                        | namespaced `name@plugin`                                                                                 |
| `commands/`        | ACP slash-command registry                            | namespaced to avoid collisions                                                                           |
| `hooks/hooks.json` | hook runner (see below)                               | bridges to Mux's hook execution                                                                          |
| `.mcp.json`        | `mcpConfigService` / `mcpServerManager`               | merged as a plugin-scoped MCP source                                                                     |

### Hooks: adopt the event-keyed `hooks.json`

Mux today has shell-script hooks (`tool_pre`/`tool_post`/`tool_env`). To accept ecosystem plugins we adopt the **event-keyed `hooks.json`** shape used by Claude Code and Codex:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "${AGENT_PLUGIN_ROOT}/hooks/guard.sh" }],
      },
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "${AGENT_PLUGIN_ROOT}/hooks/lint.sh" }] },
    ],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "..." }] }],
  },
}
```

- Mux's existing `tool_pre`/`tool_post` map to `PreToolUse`/`PostToolUse`; we extend the event set (at minimum `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop`) over time.
- Expose the vendor-neutral `${AGENT_PLUGIN_ROOT}` and `${AGENT_PLUGIN_DATA}`, plus `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` aliases for portability with existing plugins.
- Keep the existing standalone `.mux/tool_*` files working (they become the "project, no-plugin" path). This is additive, not a breaking change.

Open question: whether to also support a richer in-process event bus like opencode's for first-party features — deferred (Non-goal #2).

#### Hook coverage across tools

Three different models are in play, so "supported" is not directly comparable:

- **mux** — a few named **script files** in `.mux/` (no event keys, no matchers); `tool_pre` can block via exit code.
- **Claude Code / Codex** — **event-keyed `hooks.json`** commands with matchers and a JSON allow/deny/modify decision protocol. Codex's events are a strict subset of Claude Code's (same schema).
- **opencode** — a **code event bus** (dotted event names); mostly observational, only `permission.asked` / `tool.execute.before` are decision points. Names don't map cleanly, so portability is realistically Claude Code ↔ Codex ↔ mux, _not_ opencode.

Authoritative counts: **mux 4**, **Codex 10**, **Claude Code 31**, **opencode ~30**.

| Lifecycle point             | mux         | Claude Code                                  | Codex                            | opencode (observational)                                |
| --------------------------- | ----------- | -------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| Session start               | —           | `SessionStart`                               | `SessionStart`                   | `session.created` / `server.connected`                  |
| Session end                 | —           | `SessionEnd`                                 | —                                | `session.deleted`                                       |
| Workspace/worktree create   | `.mux/init` | `WorktreeCreate`                             | —                                | —                                                       |
| Worktree remove             | —           | `WorktreeRemove`                             | —                                | —                                                       |
| User prompt submit          | —           | `UserPromptSubmit` (+`UserPromptExpansion`)  | `UserPromptSubmit`               | ≈ `tui.prompt.append`                                   |
| **Pre-tool** (block/modify) | `tool_pre`  | `PreToolUse`                                 | `PreToolUse`                     | `tool.execute.before`                                   |
| **Post-tool**               | `tool_post` | `PostToolUse` (+`…Failure`, `PostToolBatch`) | `PostToolUse`                    | `tool.execute.after`                                    |
| Permission decision         | —           | `PermissionRequest` / `PermissionDenied`     | `PermissionRequest`              | `permission.asked` / `permission.replied`               |
| Bash env setup              | `tool_env`  | —                                            | —                                | `shell.env`                                             |
| Subagent start / stop       | —           | `SubagentStart` / `SubagentStop`             | `SubagentStart` / `SubagentStop` | —                                                       |
| Turn stop                   | —           | `Stop` / `StopFailure`                       | `Stop`                           | `session.idle`                                          |
| Compaction                  | —           | `PreCompact` / `PostCompact`                 | `PreCompact` / `PostCompact`     | `experimental.session.compacting` / `session.compacted` |
| Notification                | —           | `Notification`                               | —                                | `tui.toast.show`                                        |
| File changed on disk        | —           | `FileChanged`                                | —                                | `file.edited` / `file.watcher.updated`                  |
| Cwd changed                 | —           | `CwdChanged`                                 | —                                | —                                                       |
| Config changed              | —           | `ConfigChange`                               | —                                | —                                                       |
| Instructions loaded         | —           | `InstructionsLoaded`                         | —                                | —                                                       |
| Message display/stream      | —           | `MessageDisplay`                             | —                                | `message.part.updated`                                  |
| Task created / completed    | —           | `TaskCreated` / `TaskCompleted`              | —                                | `todo.updated` (loose)                                  |
| LSP diagnostics             | —           | —                                            | —                                | `lsp.client.diagnostics` / `lsp.updated`                |
| MCP elicitation             | —           | `Elicitation` / `ElicitationResult`          | —                                | —                                                       |
| Install / setup             | —           | `Setup`                                      | —                                | `installation.updated`                                  |

**Target event set for the `hooks.json` bridge** (the common core shared by Claude Code and Codex, so plugins are portable): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `PreCompact`, `PostCompact`. mux's existing `tool_pre`/`tool_post`/`init`/`tool_env` map onto `PreToolUse`/`PostToolUse`/(≈)`SessionStart`/(mux-specific) respectively; the rest are added incrementally.

### Marketplace format and sources

Marketplaces are registered under the vendor-neutral `.agents/plugins/marketplace.json` — `<repo>/.agents/plugins/marketplace.json` for project/team marketplaces and `~/.agents/plugins/marketplace.json` for personal ones — matching Codex exactly so a marketplace repo is shareable across agents. Example `marketplace.json`:

```jsonc
{
  "name": "acme-plugins",
  "owner": { "name": "Acme", "url": "https://acme.dev" },
  "plugins": [
    { "name": "postgres-toolkit", "source": { "type": "github", "repo": "acme/postgres-toolkit" } },
    { "name": "py-lint", "source": { "type": "npm", "package": "@acme/mux-py-lint" } },
    { "name": "local-thing", "source": { "type": "local", "path": "./plugins/local-thing" } },
  ],
}
```

Source backends in v1: **`github`/`git`, `local`, `npm`** (npm is first-class — both Claude Code and opencode rely on it). The existing `skills.sh` catalog can be extended to index `marketplace.json` files and serve discovery/search, reusing `skillsCatalogFetch` plumbing.

CLI / palette actions:

- `mux plugin marketplace add <owner/repo | path | url>`
- `mux plugin install <name>` / `enable` / `disable` / `update` / `uninstall` / `list`
- Command-palette equivalents for the desktop app.

### Install, versioning, storage

The split mirrors Codex: **marketplace registration/authoring is vendor-neutral (`.agents/`), but resolved installs and Mux-internal state stay Mux-owned** (because trust grants, version pinning, and any patching are tool-specific and must not be silently shared across agents).

- Install cache: `~/.mux/plugins/cache/<marketplace>/<plugin>/<version>/` (Mux-owned; Codex likewise caches under `~/.codex/`, not `.agents/`).
- Versioning: manifest `version` pins; absent → git SHA (Claude Code's behavior). Marketplace entry may pin/override.
- Enablement and per-plugin trust state persist in `~/.mux/config.json` (Mux-internal), with a project-scoped opt-in via the repo's `.agents/plugins/`.
- Orphaned versions GC'd after a grace period so in-flight sessions keep working.

### Trust & security (the differentiator)

Plugins can carry **executable** components (hooks run shell, MCP servers run processes). Mux already has `policyService` + runtime trust; we make trust a first-class gate:

1. **Declarative-only plugins** (skills/agents/commands, no hooks/MCP) may auto-enable.
2. **Code-bearing plugins** install **disabled** (`defaultEnabled:false` enforced regardless of manifest) and require an explicit per-plugin **trust grant**, surfaced with a clear summary of what will run (which hooks/events, which MCP commands).
3. Trust is recorded per plugin+version+source; a version bump that changes hook commands or MCP servers **re-prompts**.
4. Marketplace allow/deny lists (à la Claude Code's managed marketplaces) for org/enterprise control.
5. Hooks/MCP execute through Mux's existing runtime layer, so workspace runtime isolation (local/SSH/container) and policy gating already apply — Mux can offer **stronger per-plugin isolation than any of the three** prior tools.

### Compatibility strategy (compat vs native — the key decision)

**Recommendation: vendor-neutral, compatible, with Mux-owned state.** Author and register against the vendor-neutral `.agents/` namespace (`.agents/plugin.json`, `.agents/plugins/marketplace.json`) that Codex already uses, accept the `.claude-plugin`/`.codex-plugin` layouts and the `hooks.json`/`marketplace.json` shapes, and expose `${AGENT_PLUGIN_ROOT}` + `${CLAUDE_PLUGIN_ROOT}`. Keep resolved installs, enablement, and trust state Mux-owned under `~/.mux/`. Rationale:

- Authoring/distribution stays unbranded, so plugins and marketplaces are portable across agents rather than tied to Mux — the same bet Codex made with `.agents/`.
- Claude Code + Codex have converged, so a small compatibility surface unlocks a large existing ecosystem (and the skills are already agentskills.io-standard).
- Trust and install state are intentionally _not_ shared across agents: a grant given to one tool must not implicitly authorize another, so that state stays under `~/.mux/`.
- opencode-style code plugins are intentionally out of scope; their value (rich event bus) is a separate, first-party concern.

## Phasing

1. **Plugin loader + manifest (declarative-only):** parse `.agents/plugin.json` (+ `.claude-plugin`/`.codex-plugin`), load `skills/`, `agents/`, `commands/` into existing registries with a `plugin` scope and namespacing. Local-source install only. No code execution. Low risk; immediately useful.
2. **Marketplace + install lifecycle:** `marketplace.json`, sources (github/git, local, npm), install cache, enable/disable/update/uninstall, palette + CLI. Generalize `skills.sh` indexing.
3. **Hooks + MCP from plugins, gated by trust:** event-keyed `hooks.json` runner, `.mcp.json` → `mcpServerManager`, the trust model, env vars. Highest risk (code execution) — lands last, behind explicit trust.
4. **Polish / ecosystem:** Codex `interface{}` display metadata, managed allow/deny lists, validation command (`mux plugin validate`), docs page + cross-link from the skills docs.

## Risks and open questions

- **Security (highest):** installing third-party hooks/MCP runs code. Mitigated by default-disabled + explicit trust + runtime isolation, but the UX of conveying risk is hard. Must not regress the "startup never crashes" invariant — a bad plugin must degrade to skipped, not fatal.
- **npm execution surface:** npm-sourced plugins may carry lifecycle scripts; install with `--ignore-scripts` and only run declared components.
- **Namespacing & precedence:** plugin skills/commands/agents can collide with project/global ones; precedence rules (project > plugin > global > built-in) and `name@plugin` namespacing must be unambiguous.
- **Compat scope creep:** how much of Claude Code's surface (LSP, monitors, themes) to accept vs ignore-gracefully. v1 ignores unknown components without failing the load.
- **Marketplace trust/provenance:** version pinning, signature/provenance, and allow/deny lists for orgs — partially deferred.
- **Open question:** do we want a first-party in-process event bus (opencode-style) for Mux's own features, separate from the portable shell-hook bridge? Deferred but worth deciding before Phase 3 hardens the hook model.
- **Open question:** should the existing `skills.sh` catalog become the canonical Mux marketplace index, or stay skills-only with plugins discovered via git/npm? Affects Phase 2.

## Appendix: sources

- Agent Skills spec — https://agentskills.io/specification
- Claude Code plugins reference — https://code.claude.com/docs/en/plugins-reference ; marketplaces — https://code.claude.com/docs/en/plugin-marketplaces ; hooks — https://code.claude.com/docs/en/hooks
- Codex plugins — https://developers.openai.com/codex/plugins ; build — https://developers.openai.com/codex/plugins/build ; hooks — https://developers.openai.com/codex/hooks
- opencode plugins — https://opencode.ai/docs/plugins/ ; config — https://opencode.ai/docs/config/
- Mux hooks — `docs/hooks/` (`init`, `tools`, `environment-variables`)
