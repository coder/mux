# PRD — Mux Extension Modules v1

> **Status:** Proposed replacement for the npm/package-based extension prototype.
> **Companion docs:**
>
> - Domain glossary: `rfc/extensions-platform-context.md`
> - ADR-0001: `docs/adr/0001-permissions-are-requests-not-grants.md`
> - ADR-0002: `docs/adr/0002-stable-v1-excludes-code-execution-surfaces.md`
> - ADR-0003: `docs/adr/0003-extension-identity-vs-distribution-identity.md`
> - ADR-0004: `docs/adr/0004-v1-is-an-additive-platform-with-a-demo-extension.md`
> - ADR-0005: `docs/adr/0005-v1-platform-security-boundaries.md`
>
> Terminology in **bold** is defined in `rfc/extensions-platform-context.md` and is canonical for code, comments, UI, docs, and reviews.

---

## Problem Statement

Mux needs an extension platform that supports local authoring, hot reload, git-based sourcing, and team-reproducible project extension sets without requiring authors to publish npm packages or maintain a `package.json` manifest. The package-based prototype made package identity, package version drift, and npm dependency scanning central to the design; that does not match the desired Mux-native workflow:

- users should be able to create an extension from Mux and edit it immediately;
- organizations should be able to pin extensions by git tag, branch, SHA, or vendored source;
- project repositories should be able to declare extension sources through a lockfile without injecting trust;
- extension contribution registration should be authored in TypeScript instead of duplicated in a package manifest;
- the first shippable surface should remain small and safe: extension-contributed agent skills.

The npm/package prototype is still experimental, so v1 should supersede it rather than carry two extension systems.

---

## Solution Summary

Ship **Mux Extension Modules v1**: a folder-based extension architecture where each **Extension Module** is a directory containing `extension.ts`. The directory basename is the **Extension Name** and `manifest.name` must match it, mirroring the existing agent skill rule that `SKILL.md` frontmatter must match its parent directory.

`extension.ts` exports:

```ts
import { defineManifest } from "mux:extensions";

export const manifest = defineManifest({
  name: "acme-review",
  displayName: "Acme Review",
  description: "Review helpers for Acme",
  capabilities: {
    skills: true,
  },
});

export function activate(ctx) {
  ctx.skills.register({
    name: "review",
    bodyPath: "./skills/review/SKILL.md",
  });
}
```

The **Static Manifest** is extracted without executing extension code. Concrete contributions are registered by `activate(ctx)`, first in **Registration Discovery** mode after root trust, then in **Full Activation** mode after enablement and approvals. V1 implements only skill registration through `ctx.skills.register`.

Source/versioning moves out of the manifest and into **Extension Source Lock** files and Mux's PNPM-inspired store. Git tags, branches, SHAs, optional `//subdir` coordinates, and content hashes are source metadata, not manifest fields.

---

## Goals

1. Replace the npm/package extension prototype with folder-based Extension Modules.
2. Support Mux-native local extension authoring and hot reload.
3. Support git/source based install coordinates: tag, branch, SHA, and optional `//subdir`.
4. Keep project reproducibility through repo-trackable source locks.
5. Keep trust, enablement, and capability approvals outside project repositories.
6. Reuse the PTC QuickJS sandbox direction for post-trust extension execution.
7. Implement one contribution surface first: agent skills.
8. Preserve existing skill identity and precedence semantics.
9. Keep the Extension Platform always initialized so future built-in skill migrations remain available.

## Non-goals for v1

- npm/package.json extension discovery.
- npm dependency imports from extension code.
- setup/install scripts.
- command, tool, panel, runtime, theme, layout, MCP, secret-provider, or model effect APIs.
- pre-trust execution of project-local extension code.
- source/content changes invalidating existing Effect Capability approvals.
- a public extension catalog.

---

## Core User Stories

### US-001 — Create a local extension

A user can create an editable extension folder under Mux's global extension area and see it hot reload after edits.

Acceptance:

- Mux scaffolds or recognizes `~/.mux/extensions/local/<name>/extension.ts`.
- The folder name must be a valid Extension Name.
- `manifest.name` must match the folder name.
- Static Manifest diagnostics appear without crashing the app.
- A changed `extension.ts` or referenced skill file triggers rediscovery for that extension.

### US-002 — Install an extension from git

A user can install an extension from a git source by tag, branch, SHA, or root/subdir coordinate.

Examples:

```bash
mux extensions install github.com/acme/mux-review@v0.1.0
mux extensions install github.com/acme/mux-review@main
mux extensions install github.com/acme/mux-extensions//extensions/review@abc123
```

Acceptance:

- Mux resolves the source to a commit SHA.
- Mux locates `extension.ts` at the repo root or `//subdir`.
- Mux statically extracts `manifest.name` before choosing the installed Extension Name.
- Mux stores fetched content in `~/.mux/extensions/store/<content-hash>/`.
- Mux writes global source metadata to `~/.mux/extensions/lock.json`.

### US-003 — Project declares extensions reproducibly

A repository can commit `<project>/.mux/extensions.lock.json` to declare desired extension sources.

Acceptance:

- Before project trust, Mux may show that the project declares extensions but must not fetch, parse remote extension code, transpile, or execute extension code.
- After project/root trust, Mux may sync locked sources into the global content-addressed store.
- Trust, enablement, and Capability Approval state is stored only outside the repo in Mux-controlled global state.
- A committed lockfile cannot cause extension execution by itself.

### US-004 — Vendored project extensions

A repository can vendor extension source under `<project>/.mux/extensions/<name>/extension.ts`.

Acceptance:

- Vendored extension code is treated as repo-controlled and remains existence-only before trust.
- After trust, Mux statically extracts its manifest, runs Registration Discovery, and can activate it if enabled.
- Vendored source may be represented in the project lock by content hash/source metadata.

### US-005 — Registration Discovery previews skills

After trust, Mux runs `activate(ctx)` in discovery mode to collect intended skill registrations.

Acceptance:

- Discovery runs in QuickJS with bounded memory and timeout.
- `ctx.mode` is `"discover"`.
- `ctx.skills.register` collects descriptors and returns no-op disposables.
- Effect Capability APIs cannot perform side effects in discovery mode.
- Discovery failures surface diagnostics and do not crash startup.

### US-006 — Full Activation publishes only discovered skills

When an extension is trusted, enabled, and allowed to use its registration capabilities, Mux runs Full Activation and publishes live skills.

Acceptance:

- Activation runs in a fresh long-lived sandbox session.
- Activation is async-capable but bounded by timeout and abort controls.
- If activation fails, Mux disposes partial registrations and does not publish them.
- On hot reload, Mux keeps the previous good activation unless trust/capability revocation requires immediate shutdown.
- Full Activation may register only skills observed during Registration Discovery.

### US-007 — Extension skills follow existing skill identity rules

Extension-registered skills behave consistently with file/custom skills.

Acceptance:

- `ctx.skills.register({ name, bodyPath })` requires `name` to satisfy `SkillNameSchema`.
- `bodyPath` must resolve inside the Extension Module realpath.
- The referenced `SKILL.md` must pass the existing parser and size checks.
- `SKILL.md` frontmatter `name` must match the registered skill name.
- Extension skills sit below project/global custom skills and above built-ins in skill precedence.

### US-008 — Capability model stays small in v1

V1 implements registration capabilities for skills only.

Acceptance:

- `manifest.capabilities.skills === true` is required before `ctx.skills.register` can succeed.
- Undeclared registration capability use throws a typed diagnostic error.
- Effect Capability schema may be modeled for future use but no dangerous effect API is exposed in v1.

### US-009 — Root precedence matches skills

Duplicate Extension Names across roots shadow by precedence.

Acceptance:

- Project-local active extension shadows user-global active extension of the same name.
- User-global active extension shadows bundled non-core extension of the same name.
- Shadowed extensions remain inspectable but do not activate.
- Reserved/core bundled names cannot be shadowed if marked core.

### US-010 — Platform availability is stable

The Extension Platform has no user-facing kill switch because future built-in skill migrations depend on extension-contributed skills remaining available.

Acceptance:

- The Settings section and palette actions are always reachable.
- Extension discovery and activation are initialized on startup without an experiment gate.
- Deprecated policy or experiment state cannot hide extension-provided skills.

---

## Architecture

### Source layout

Global Mux extension storage uses a split layout:

```text
~/.mux/extensions/
  local/      # editable user-created sources
  store/      # immutable content-addressed fetched sources
  global/     # active global view by Extension Name
  projects/   # active project views by project key and Extension Name
  lock.json   # global source lock
  trust.jsonc # Mux-owned security state, never repo-tracked
```

Project repositories may contain:

```text
<project>/.mux/extensions.lock.json
<project>/.mux/extensions/<name>/extension.ts
```

Project repositories must not contain security state.

### Git/source coordinates

Supported coordinate shape:

```text
<git-url-or-shorthand>[//subdir][@ref]
```

Examples:

```text
github.com/acme/mux-review@v0.1.0
github.com/acme/mux-review@main
github.com/acme/mux-extensions//extensions/review@abc123
```

The install/sync flow resolves the ref to a SHA, validates the extension folder, computes a content hash, and materializes from the store into an active view.

### Static Manifest extraction

The extractor accepts only a statically analyzable manifest export, for example:

```ts
export const manifest = defineManifest({
  name: "acme-review",
  displayName: "Acme Review",
  description: "Review helpers",
  capabilities: { skills: true },
});
```

The manifest is context-free and must not depend on project path, environment, runtime state, source ref, previous approvals, or executed code. It has no required version field.

### Sandbox execution

V1 reuses the PTC QuickJS direction but introduces an extension-host layer on top:

- TypeScript transpile/bundle for `extension.ts` and contained relative imports/resources.
- `mux:*` virtual modules only; npm/bare imports are rejected except for `mux:*`.
- Realpath containment for every resolved relative module/resource.
- Fresh sandbox for Registration Discovery.
- Long-lived sandbox session for Full Activation.
- Memory limits, activation timeouts, handler timeouts, console capture, and abort/dispose controls.

### Registration Discovery and activation comparison

Registration Discovery defines a maximum contribution set. Full Activation may register a subset of discovered contributions but may not register a skill absent from discovery.

Comparison for v1 skills uses at least:

- contribution type: `skill`;
- skill name;
- referenced `bodyPath` after normalized extension-relative resolution.

Undiscovered full-activation registrations are activation errors.

---

## Security and Trust

### Pre-trust behavior

- Bundled/user-global roots may be statically parsed before trust.
- Project-local roots are existence-only before trust.
- Project lockfiles do not trigger fetch, parse, transpile, or execution before project/root trust.
- No `extension.ts` code executes before root trust in any scope.

### Approvals outside repos

Trust, enablement, and Effect Capability approvals live under Mux-controlled global storage, keyed by global/project scope and Extension Name. They are never read from project files and cannot be injected by a repository.

### Capability approval drift

Effect approvals drift only when requested Effect Capabilities expand or strengthen. Source/content changes alone do not revoke existing approvals. V1 skills-only registration has no dangerous effect API.

### Snapshot/cache boundary

Cached snapshots may accelerate inspection UI but must not be the source of truth for live activation or skill capability decisions. Live discovery/activation results drive the Capability Path.

---

## First Implementation Scope

V1 implementation should support:

- Extension Module discovery from active views and optional vendored project sources.
- Static Manifest extraction and validation.
- Extension Name validation and `manifest.name` mismatch diagnostics.
- Root trust gating and skill-like root precedence.
- Registration Discovery in QuickJS for `ctx.skills.register`.
- Full Activation in QuickJS for skills.
- Extension skill source integration with existing agent skill discovery/read paths.
- Global security state outside project repos.
- Source lock schemas and store layout enough to support local and fetched/global flows.
- Settings UI language updated from packages/permissions to folders/sources/capabilities.

V1 may defer:

- command/effect APIs;
- setup scripts;
- public catalog;
- immutable snapshots for local editable extensions;
- rich git install UI if CLI/debug commands are enough to dogfood.

---

## Testing Strategy

### Unit tests

- manifest extraction accepts only static manifests;
- folder name and `manifest.name` mismatch rejects;
- invalid names reject with stable diagnostics;
- source lock schemas parse global/project lock examples;
- security state cannot be loaded from project paths;
- root precedence shadows by Extension Name;
- Registration Discovery collects skills and rejects undeclared `skills` capability;
- Full Activation rejects undiscovered skills;
- skill `bodyPath` containment, size, and frontmatter-name matching;
- project lock pre-trust does not fetch/parse/execute.

### Integration tests

- local editable extension appears after creation and hot reloads;
- fetched git source resolves to store and active view;
- project lock sync only after trust;
- vendored project extension remains existence-only pre-trust and activates after trust;
- extension skill appears in slash menu/agent skill listing;
- higher-precedence project extension shadows global extension of same name;
- extension skills remain available across reloads without any platform-level experiment gate.

### Security regression tests

- project repo cannot inject trust/enablement/approvals by committing files;
- relative imports/resources cannot escape extension root through `..` or symlink traversal;
- `extension.ts` top-level code and `activate` never run before trust;
- discovery mode effect APIs cannot perform side effects;
- npm/bare imports are rejected except `mux:*`.

---

## Dogfooding Plan

Dogfooding must capture reviewer-verifiable evidence. For UI-related steps, run a dev build and use `agent-browser` or Electron automation to capture screenshots and video/snapshots.

1. **Local authoring path**
   - Create `~/.mux/extensions/local/acme-review/extension.ts` and `skills/review/SKILL.md`.
   - Start Mux.
   - Verify the extension appears in Settings and the skill appears in the slash/skill surface.
   - Edit `SKILL.md`; verify hot reload updates the skill.
   - Capture Settings and skill-picker screenshots.

2. **Project lock path**
   - Add `<project>/.mux/extensions.lock.json` pointing at a test git source/ref.
   - Open the project before trust; verify Mux shows only that extensions are declared.
   - Trust project extensions; verify source sync and Registration Discovery diagnostics.
   - Capture before/after trust screenshots.

3. **Vendored project source path**
   - Add `<project>/.mux/extensions/acme-review/extension.ts` and skill files.
   - Verify no pre-trust execution.
   - Trust, enable, activate, and verify skill availability.

4. **Shadowing path**
   - Install a global extension and a project-local extension with the same Extension Name.
   - Verify project-local shadows global and global is inspectable as shadowed.

5. **Kill switch path**
   - Toggle the experiment/Governor policy off.
   - Verify Settings/palette surfaces disappear or disable and extension skills are removed.
   - Toggle back on and verify previous locks/security state restore behavior.

---

## Open Questions

- Exact project key used under `~/.mux/extensions/projects/<project-key>/` and security state.
- Whether global security state should live in `~/.mux/extensions/trust.jsonc` or be folded into existing `~/.mux/config.json`.
- Whether local editable extensions should activate directly in v1 or snapshot to store before every activation.
- Whether bundled core names are needed in skills-only v1.
- Exact CLI syntax and UI flows for install/update/sync/create.
