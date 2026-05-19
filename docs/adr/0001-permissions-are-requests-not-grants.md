# Effect capabilities require local approval; registration capabilities are auto-approved

Extension Modules declare capability classes in their statically extracted `manifest.capabilities` object. Those declarations are author-controlled requests, not authority. V1 splits capabilities into **Registration Capabilities** and **Effect Capabilities**. Registration Capabilities, initially only `skills`, are auto-approved after root trust and enablement because they only register host-validated descriptors. Effect Capabilities such as shell, network, secrets, workspace files, git, or model access require explicit **Capability Approval** stored in Mux-controlled local state outside project repositories.

## Considered Options

- **Manifest capabilities are grants.** Rejected: a repository or downloaded source could self-authorize dangerous host APIs by changing `extension.ts`.
- **Keep the package-prototype `requestedPermissions` / Grant Record model.** Rejected: it was designed around package manifests, inferred contribution permissions, and distribution identity drift. Extension Modules need a smaller capability-class model where `ctx` is the enforcement boundary.
- **Require approval for all registration capabilities.** Rejected for skills-first v1 because skill registration is host-validated, contained, and already lower precedence than user project/global skills.
- **Trust + enable grants every declared capability.** Rejected: project-local code and fetched source must not receive shell/network/secrets authority just because a root was trusted for inspection.

## Decision

- The Static Manifest declares capability classes.
- Registration Capability use must be declared, but is auto-approved after trust + enablement.
- Effect Capability use requires a local Capability Approval scoped by root/project/global scope and Extension Name.
- Unapproved Effect Capability namespaces remain visible on `ctx` with `requested`, `approved`, `available`, and `reason` metadata, and throw typed errors when used.
- Capability drift is based on requested Effect Capability expansion/strengthening. Source or content changes alone do not revoke existing approvals.

## Consequences

- V1 can remove package-version and package-rename regrant churn.
- The Settings UI must distinguish requested/approved/unavailable Effect Capabilities from auto-approved registration capabilities.
- Project repositories may declare source locks, but cannot commit approvals or trust decisions.
- The first implementation can ship with only `capabilities.skills = true` and no dangerous Effect Capability API.
