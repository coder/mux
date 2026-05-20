# Mux Extension Platform

Mux's extension platform lets users and authors add capabilities to Mux without changing the core application. The v1 architecture is source-folder based: an **Extension Module** is a folder containing an `extension.ts` entrypoint, not an npm package.

## Language

**Extension Module**:
A folder under an Extension Root whose basename is the extension's canonical name and that contains an `extension.ts` entrypoint.
_Avoid_: npm package extension, package dependency, plugin bundle

**Extension Name**:
The kebab-case basename of an Extension Module folder. `manifest.name` in `extension.ts` must match this folder name. This follows the existing agent skill model where a skill directory name is the stable identity.
_Avoid_: `mux.id`, package name, reverse-domain identity

**Extension Entrypoint**:
The `extension.ts` file inside an Extension Module. It exports a statically extractable `manifest` and may export an `activate(ctx)` function.
_Avoid_: package manifest, host entry point list, activation event table

**Static Manifest**:
The context-free `manifest` export extracted from `extension.ts` without executing extension code. It declares identity metadata and capability requests; it does not list concrete contributions and does not carry a release version.
_Avoid_: computed manifest, runtime manifest, package.json `mux` envelope

**Registration Capability**:
A manifest-declared capability class that lets the extension register host-visible contributions after trust and enablement. Registration capabilities are auto-approved but must be declared before use. V1 initially supports `skills` only.
_Avoid_: requested permission, operational permission

**Effect Capability**:
A manifest-declared capability that grants authority to perform side effects such as shell execution, network access, workspace file access, secrets, model calls, or git mutations. Effect capabilities require explicit user approval and are exposed on `ctx` with availability metadata.
_Avoid_: registration capability, ambient host API

**Capability Approval**:
A local-only user decision that approves one or more Effect Capabilities for an Extension Name in a specific root/project scope. Approvals are stored outside project repositories so repo content cannot inject trust.
_Avoid_: repo-tracked permission, manifest grant

**Extension Root**:
A location that may contain Extension Modules. V1 roots are bundled extensions, user-global active extensions, and project-local active extensions materialized by Mux from locks, local sources, or vendored sources.
_Avoid_: npm-compatible root, package project

**User-local Extension Source**:
Editable extension source stored under Mux's global extension area (for example `~/.mux/extensions/local/<name>/`). Mux may hot reload it during authoring.
_Avoid_: installed package, store entry

**Extension Store**:
Mux's global content-addressed cache for fetched extension sources. Store entries are immutable and addressed by content hash.
_Avoid_: project checkout, editable source folder

**Active Extension View**:
A Mux-controlled materialized view that maps an Extension Name to either a local source or immutable store entry for a specific global or project scope.
_Avoid_: source of truth, trust record

**Extension Source Lock**:
A lock file that records desired extension sources and resolved revisions/content hashes. Global locks live under Mux's extension area; project locks may live in the repository. Locks are reproducibility metadata, not trust or approval state.
_Avoid_: capability approval, trust state, enablement state

**Project Extension Lock**:
A repo-trackable source lock such as `<project>/.mux/extensions.lock.json` that declares project-desired extensions by git source, optional subdir, requested ref, resolved SHA, and content hash.
_Avoid_: project trust file, grant record

**Extension Security State**:
Mux-owned local state outside project repositories that stores root trust, enablement, and Capability Approvals for global and project scopes.
_Avoid_: `.mux/extensions.local.jsonc`, repo-tracked trust, committed approval

**Registration Discovery**:
The post-trust sandbox run of `activate(ctx)` with `ctx.mode === "discover"`. Registration APIs collect descriptors and return no-op disposables; Effect Capability APIs are unavailable for side effects. Discovery defines the maximum contribution set an activation may later publish.
_Avoid_: dry run, validation execution, full activation

**Full Activation**:
The sandbox run of `activate(ctx)` after trust, enablement, and applicable Effect Capability approvals. Full Activation creates live registrations and a long-lived Extension Host Session.
_Avoid_: registration discovery, manifest parsing

**Extension Host Session**:
A long-lived sandbox instance for one active extension. It owns the evaluated bundle, registration handles, optional custom disposables, in-flight handler state, console attribution, timeout/abort controls, and cleanup.
_Avoid_: one-shot eval, package process

**Extension Context (`ctx`)**:
The host API object passed to `activate(ctx)`. Registration namespaces such as `ctx.skills` are present only when declared and enabled; Effect Capability namespaces expose `requested`, `approved`, `available`, and `reason` metadata and throw typed errors when unavailable.
_Avoid_: global `mux` object, Node globals

**Contribution Registration**:
A call made during `activate(ctx)` to register a concrete contribution, such as `ctx.skills.register({ name, bodyPath })`. Concrete contributions are not listed in the Static Manifest.
_Avoid_: manifest contribution descriptor

**Extension Skill Registration**:
A skills-first v1 Contribution Registration. `ctx.skills.register({ name, bodyPath })` registers a skill whose referenced `SKILL.md` frontmatter `name` must match the registration name, preserving the existing skill identity rule.
_Avoid_: skill alias, manifest skill descriptor

**Extension Shadowing**:
Skill-like precedence when multiple roots expose the same Extension Name. Project-local shadows user-global, which shadows bundled. Shadowed modules are inspectable but not activated. Core bundled names may be reserved and non-shadowable.
_Avoid_: identity conflict, duplicate package conflict

**Source Identity**:
Provenance metadata such as source kind, git URL, optional subdir, requested ref, resolved SHA, and content hash. Source Identity is used for install/update display and lock verification, not as the canonical Extension Name.
_Avoid_: distribution identity, package version

**Capability Drift**:
A change in requested Effect Capabilities compared with locally approved capabilities. Expansion or strengthening requires approval; source/content changes alone do not invalidate existing approvals.
_Avoid_: version drift, package rename drift

**Immutable Store Activation**:
Activation from a content-addressed store entry whose files should not mutate. Fetched global and project-lock extensions use this in v1. Local editable extensions may activate directly in v1, with immutable snapshots as the target architecture.
_Avoid_: live package activation

## Root and source precedence

Extension roots use skill-like precedence:

1. Project-local active extension view
2. User-global active extension view
3. Bundled extension view

Within one root, duplicate Extension Names are impossible because folders are keyed by name. Across roots, higher-precedence roots shadow lower-precedence roots unless a bundled core name is reserved.

## Trust ladder

Project-local roots are repo-controlled and are treated as attacker-controlled until trusted.

1. **Existence detection**: Mux can detect that a project declares or vendors extensions without reading or executing extension code.
2. **Static Manifest Inspection**: user-global and bundled modules may be statically parsed before root trust; project-local modules may be statically parsed only after project/root trust.
3. **Registration Discovery**: after root trust, Mux runs `activate(ctx)` in the sandbox with collector-only registration APIs.
4. **Full Activation**: after trust, enablement, and Effect Capability approvals, Mux runs `activate(ctx)` in activation mode and publishes live registrations.

## Storage model

Mux uses a PNPM-inspired split:

```text
~/.mux/extensions/
  local/      # editable user-authored sources
  store/      # immutable content-addressed fetched sources
  global/     # active global view by extension name
  projects/   # active project views keyed by Mux project identity
  lock.json   # global source lock
  trust.jsonc # local-only security state for global and project scopes
```

Project repositories may contain source metadata and optional vendored source:

```text
<project>/.mux/extensions.lock.json
<project>/.mux/extensions/<name>/extension.ts
```

Project repositories must never contain trust, enablement, or Capability Approval state.
