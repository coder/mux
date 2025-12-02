# mux Documentation

This directory contains the source for mux documentation built with [mdbook](https://rust-lang.github.io/mdBook/).

## Quick Start

```bash
# Build docs
bun docs

# Serve docs with hot reload (opens in browser)
bun docs:serve

# Watch for changes (no server)
bun docs:watch
```

## Features

- ✅ **Mermaid diagrams** - Add diagrams with ` ```mermaid ` code blocks
- ✅ **Link checking** - Automatically validates all links during build
- ✅ **GitHub Pages** - Auto-deploys to https://mux.io on push to main

## Structure

```
docs/
├── book.toml        # mdbook configuration
├── src/
│   ├── SUMMARY.md   # Table of contents
│   └── *.md         # Documentation pages
└── book/            # Build output (gitignored)
```

## Adding Content

1. Create a new `.md` file in `src/`
2. Add it to `src/SUMMARY.md` to make it appear in the sidebar
3. Use standard markdown + mermaid diagrams

## Writing Guidelines

See [STYLE.md](./STYLE.md) for documentation writing guidelines.

## CI/CD

Docs are automatically built and deployed via `.github/workflows/docs.yml` when:

- Changes are pushed to `main` branch in the `docs/` directory
- Workflow is manually triggered

## Requirements

The following tools are needed to build locally:

- `mdbook` (v0.4.52+)
- `mdbook-mermaid` (v0.16.0+)
- `mdbook-linkcheck` (v0.7.7+)
- `mdbook-pagetoc` (v0.2.1+)

Install via cargo:

```bash
cargo install mdbook mdbook-mermaid mdbook-linkcheck mdbook-pagetoc
mdbook-mermaid install docs
```
