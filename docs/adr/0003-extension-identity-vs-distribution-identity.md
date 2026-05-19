# Extension identity is the folder name; source identity lives in locks

The package prototype used a reverse-domain `mux.id` and separate npm Distribution Identity. Extension Modules follow the existing agent skill model instead: an extension is identified by its folder basename, and `manifest.name` in `extension.ts` is required to match that folder. Source provenance, git refs, SHAs, and content hashes live in lock/store metadata rather than the manifest.

## Considered Options

- **Keep reverse-domain `mux.id`.** Rejected: it conflicts with the desired skills-like folder workflow and makes local authoring heavier than necessary.
- **Use git URL or content hash as identity.** Rejected: identity would change across forks, mirrors, local edits, and lock updates. Source identity is provenance, not user-facing extension identity.
- **Use a composite folder + manifest ID.** Rejected: it adds complexity while still making folder rename semantics unclear.
- **Allow manifest name to differ from folder name.** Rejected: Mux skills already require frontmatter `name` to match the parent directory, and extensions should follow that convention.

## Decision

- The **Extension Name** is the kebab-case folder basename.
- `manifest.name` is required and must match the folder name.
- There is no required manifest version and no npm package identity.
- Git/source provenance is represented by **Source Identity** in global/project lock files and the content-addressed store.
- Duplicate Extension Names across roots use skill-like precedence: project-local shadows user-global, which shadows bundled. Core bundled names may be reserved and non-shadowable.

## Consequences

- Renaming an extension folder intentionally renames the extension; old state can be surfaced as stale local state.
- Install commands must parse `manifest.name` before choosing the target active name.
- Lock files key source entries by Extension Name but do not confer trust.
- Project-local extensions cannot inherit global approvals merely by using the same name because approvals are scoped by root/project/global scope.
