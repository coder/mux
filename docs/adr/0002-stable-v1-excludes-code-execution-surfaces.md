# Extension code executes only after trust in a QuickJS-based host

The package prototype excluded extension-authored code execution. The Extension Module architecture intentionally introduces `activate(ctx)`, but only after a trust ladder: pre-trust project-local roots are existence-only, static manifests are extracted without execution, Registration Discovery runs only after root trust, and Full Activation runs only after trust, enablement, and applicable approvals.

## Considered Options

- **Keep v1 purely declarative.** Rejected: the new folder/`extension.ts` model is meant to support Mux-native authoring, hot reload, and contribution registration without duplicating every contribution in a manifest.
- **Execute `extension.ts` in Node/Electron.** Rejected: extension code must not inherit ambient Node, filesystem, process, network, or renderer authority.
- **Run sandboxed Registration Discovery before trust.** Rejected: even no-op registration collection still executes extension code and can burn CPU, throw, or use any sandbox bug before user consent.
- **Require static contribution lists in the manifest.** Rejected: it duplicates registration code and diverges from the desired `activate(ctx)` authoring model.

## Decision

- `extension.ts` exports a statically extractable `manifest` and may export `activate(ctx)`.
- Mux never executes `extension.ts` before the relevant root is trusted.
- After trust, Mux runs **Registration Discovery** in QuickJS with collector registration APIs and unavailable effect APIs.
- After enablement and approvals, Mux runs **Full Activation** in a long-lived QuickJS Extension Host Session.
- Full Activation may publish only contributions observed during Registration Discovery.
- `activate(ctx)` may be async, but activation is bounded by timeouts and atomic cleanup.

## Consequences

- The PTC QuickJS runtime concepts are reusable, but an extension-host layer must add TypeScript bundling, `mux:*` virtual modules, export handling, retained handler invocation, and lifecycle/disposal management.
- Registration Discovery is a contribution contract, not a side-effect permission grant.
- Failed activation must dispose partial registrations and keep last-good activation during hot reload unless trust/capability revocation requires shutdown.
- Static analysis remains important for forbidden imports/globals, but v1 does not try to prove top-level purity.
