# v1 is an additive skills-only Extension Module release with a bundled demo

Stable v1 ships the folder-based Extension Module platform, not migrations of existing built-in features. The bundled extension set contains a single non-core demo Extension Module that registers one skill through `activate(ctx)`. The platform is always initialized because future built-in skill migrations depend on extension-contributed skills remaining available.

## Considered Options

- **Migration-first v1.** Rejected: moving built-in themes, layouts, runtimes, agents, tools, or secrets to the new host would combine platform risk with migration risk.
- **Ship commands/effect APIs in v1.** Rejected: commands and side-effect APIs require handler invocation, approval UX, and stronger runtime semantics. Skills are enough to validate the source/discovery/activation path.
- **Keep the npm/package prototype as a compatibility path.** Rejected: the feature is experimental and unmerged; carrying two architectures would confuse authors and double the security surface.
- **No demo extension.** Rejected: without a bundled demo, shipped builds would not exercise the end-to-end platform path by default.
- **Expose a platform kill switch.** Rejected: built-in skills may migrate onto Extensions, so a user-facing off switch would remove core functionality and create a degraded experience.

## Decision

- V1 contribution support is skills only.
- The Platform Demo Extension is an Extension Module folder with `extension.ts`, `manifest.name`, `capabilities.skills = true`, and `ctx.skills.register(...)`.
- No existing built-in feature is migrated in v1.
- The Extension Platform has no experiment or Governor kill switch; discovery, Registration Discovery, Full Activation, Settings UI, and skill integration are always available.

## Consequences

- Existing Mux behavior remains unchanged for users who never enable or install third-party extensions.
- Tests and dogfood focus on local/global/project extension source, trust gating, skill registration, shadowing, and always-on availability.
- Future releases can add commands, effect APIs, setup scripts, catalogs, immutable local snapshots, and built-in migrations through separate design passes.
