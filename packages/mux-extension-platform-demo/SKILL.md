---
name: mux-extensions
description: Explains how the Mux Extension Platform works — roots, trust, enable, grants, contributions, and skill precedence — from inside Mux.
---

# mux-extensions

A guide to Mux Extension Modules — what an Extension Module is, where it lives,
how it gets activated, and how to reason about trust, capabilities, source locks,
and contributed skills. This skill is contributed by the bundled Platform Demo
Extension Module and ships with every copy of Mux.

## What an Extension Module is

An **Extension Module** is a directory whose basename is the **Extension Name**
and that contains an `extension.ts` file. The file exports a static `manifest`
whose `name` must match the directory name, plus an `activate(ctx)` function that
registers contributions.

For v1, the stable contribution surface is intentionally small:

```ts
export const manifest = {
  name: "acme-review",
  capabilities: { skills: true },
};

export function activate(ctx) {
  ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
}
```

Mux extracts the Static Manifest without executing extension code. After root
trust, Mux runs Registration Discovery in QuickJS with `ctx.mode === "discover"`
to collect intended skill registrations. After enablement and approval, Full
Activation runs in a fresh sandbox and may publish only skills observed during
Registration Discovery.

## Where Extension Modules live

Mux discovers modules from Extension Roots:

| Root          | Path / source                                                    | Trust            |
| ------------- | ---------------------------------------------------------------- | ---------------- |
| Bundled       | shipped inside the Mux app artifact                              | always trusted   |
| User-global   | `~/.mux/extensions/local/<name>/extension.ts`                    | always trusted   |
| Fetched       | `~/.mux/extensions/global/<name>/extension.ts`                   | always trusted   |
| Project-local | `<project>/.mux/extensions/<name>/extension.ts` or project locks | requires consent |

Git-installed modules are pinned by Extension Source Locks and materialized into
Mux-owned active views. Project repositories may commit `.mux/extensions.lock.json`
or vendored source, but trust, enablement, and approvals live only in Mux-owned
global state.

## The Trust → Enable → Capability ladder

Three decisions gate every Extension Module:

1. **Trusted Extension Root.** Project-local roots are existence-only until the
   user grants extension-root trust.
2. **Enabled.** Whether the Extension Module is turned on.
3. **Capability approval.** V1 exposes only the `skills` registration capability;
   no dangerous effect API is available.

Disabling does not delete source locks or approvals. Revoking trust removes live
capability output immediately.

## Discovery and activation

Before project trust, Mux may show that a project declares extensions but must
not fetch, parse, transpile, or execute project-controlled extension code. After
trust, Mux may sync locked sources into the content-addressed store, statically
extract manifests, run Registration Discovery, and activate enabled skills.

The platform is always initialized because future built-in skills may be served
through Extension Modules. Individual third-party Extensions can still be
disabled or unapproved without hiding core extension-provided functionality.

## Skill precedence

Extension-contributed skills follow the same identity rules as file-based custom
skills. Project-local active modules shadow user-global modules with the same
Extension Name; user-global modules shadow non-core bundled modules; core bundled
modules cannot be shadowed.

## Where to go next

- Create a local module under `~/.mux/extensions/local/<name>/extension.ts`.
- Pin a git source in `~/.mux/extensions/lock.json` or a project
  `.mux/extensions.lock.json`.
- Use Settings → Extensions to inspect roots, enable modules, grant
  capabilities, and reload after edits.
- **Extension authoring quickstart** — see `docs/extensions/authoring.mdx`
  for a copy-paste manifest plus the `@coder/mux-extension-platform-demo` source
  alongside this skill.

This Extension is **not Core**: you can disable it from the Extensions
Settings Section. Doing so removes the `mux-extensions` skill from the
skills picker but leaves the rest of the platform untouched.
