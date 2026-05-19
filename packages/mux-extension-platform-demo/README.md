# mux-platform-demo

The **Platform Demo Extension Module** is the canonical bundled reference
implementation for Mux Extension Modules v1.

## Why this module exists

- **It exercises the platform end-to-end.** Every release ships this module so
  Static Manifest extraction, Registration Discovery, conflict resolution,
  capability calculation, and skill activation are always in use.
- **It is the docs entry point.** The contributed `mux-extensions` skill explains
  the user-facing platform model from inside Mux.
- **It is the starter template for Extension authors.** Copy this directory or
  mirror its `extension.ts` + `SKILL.md` shape to start a new module.

This is **not** a Core Extension Module. Users can disable it from
**Settings → Extensions**.

## Layout

```text
packages/mux-extension-platform-demo/
├── extension.ts    # Static Manifest + activate(ctx) registration
├── SKILL.md        # body of the contributed `mux-extensions` skill
├── package.json    # repo build metadata only; not the extension manifest
└── README.md       # this file
```

The bundled assemble step copies this directory to
`build/extensions/mux-platform-demo/`, where the folder basename is the Extension
Name and `manifest.name` must match it.

## Manifest

The Static Manifest lives in `extension.ts`:

```ts
export const manifest = {
  name: "mux-platform-demo",
  capabilities: { skills: true },
};
```

The module registers its skill from `activate(ctx)` using
`ctx.skills.register({ name, bodyPath })`. V1 supports skill registration only;
source versioning and git refs live in Extension Source Locks, not in the
manifest.

## Versioning

Bundled modules are inlined into the Mux artifact and are not published to npm in
v1. The local `package.json` exists only so repository tooling can track this
fixture with the app.

## Authoring a new Extension Module from this template

1. Copy the `extension.ts` + skill file layout into
   `~/.mux/extensions/local/<name>/` or a git repository.
2. Update `manifest.name` to match the containing folder basename.
3. Replace the contributed skill with your own `SKILL.md`.
4. Reload Extensions in Mux.

See `docs/extensions/authoring.mdx` for the full authoring reference.

## License

AGPL-3.0-only — same as the Mux repository.
