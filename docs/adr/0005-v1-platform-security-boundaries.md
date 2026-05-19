# v1 security boundaries: no repo-injected trust, contained source, reserved names, and cache/display separation

Extension Modules allow code execution after trust, so v1 security boundaries focus on preventing repository-controlled files from injecting trust, preventing path/source escapes, preventing first-party impersonation, and keeping cached inspection data out of live capability decisions.

## Considered Options

- **Store project trust/approvals under `<project>/.mux`.** Rejected: gitignore is not a security boundary. A repository could commit or generate local-looking trust files and inject approvals into every Mux instance that opens it.
- **Fetch/parse project extension locks before trust.** Rejected: a repo-controlled lockfile could trigger network access, source parsing, or dependency work before the user trusts the project.
- **Use package reserved prefixes (`mux.*`).** Rejected: Extension Names now follow kebab-case folder identity; the reserved first-party namespace should use folder-compatible names such as `mux-*`.
- **Trust cached snapshots for activation.** Rejected: snapshot freshness is best-effort. Live Static Manifest extraction, Registration Discovery, and Full Activation results must drive capability paths.

## Decision

- Project repositories may contain source locks and optional vendored extension source, but never trust, enablement, or Capability Approval state.
- Mux-owned extension security state lives outside repositories under global Mux storage.
- Project-local roots are existence-only before trust. Mux must not fetch, parse, transpile, or execute project-declared extension code before trust.
- Relative imports/resources must resolve by realpath containment inside the Extension Module root; npm/bare imports are rejected except `mux:*`.
- Non-bundled extensions cannot use reserved first-party names such as `mux-*`; bundled core names may be non-shadowable.
- Snapshot caches are display/inspection accelerators only. Activation and skill availability come from live discovery/activation.
- Extension iconography remains generic until raw SVG/HTML sanitization has a dedicated design.

## Consequences

- The previous project-local `.mux/extensions.local.jsonc` design is superseded for security state. Any project-scoped approvals must be keyed in global Mux state by project identity/scope.
- The Settings UI must make source locks distinct from trust/approval state.
- Source lock sync for project extensions can happen only after project/root trust.
- Tests must assert that committed project files cannot grant trust or Effect Capabilities and that pre-trust project extension code is never executed.
