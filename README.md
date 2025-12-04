<div align="center">

<img src="docs/img/logo.webp" alt="mux logo" width="15%" />

# mux - coding agent multiplexer

[![CI](https://github.com/coder/mux/actions/workflows/ci.yml/badge.svg)](https://github.com/coder/mux/actions/workflows/ci.yml)
[![Build](https://github.com/coder/mux/actions/workflows/build.yml/badge.svg?event=merge_group)](https://github.com/coder/mux/actions/workflows/build.yml?query=event:merge_group)
[![Download](https://img.shields.io/badge/Download-Releases-purple)](https://github.com/coder/mux/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)

</div>

> 🎟️ **Have a voucher code?** Redeem it at [gateway.mux.coder.com](https://gateway.mux.coder.com)

![mux product screenshot](docs/img/product-hero.webp)

A desktop application for parallel agentic development.

<details>
<summary>Why parallelize?</summary>

Here are some specific use cases we enable:

- **Contextual continuity between relevant changes**:
  - e.g. create a workspace for `code-review`, `refactor`, and `new-feature`
- **GPT-5-Pro**: use the slow but powerful GPT-5-Pro for complex issues
  - Run in the background for hours on end
  - The stream will automatically resume after restarts or intermittent connection issues. If the model completes early we will show an indicator.
- **A/B testing**: run multiple workspaces in parallel on the same problem but different approaches,
  abandon the bad ones.
- **Tangent exploration**: launch tangents in `mux` away from main work

</details>

## Features

- **Isolated workspaces** with central view on git divergence ([docs](https://mux.coder.com/runtime.html))
  - **[Local](https://mux.coder.com/runtime/local.html)**: run directly in your project directory
  - **[Worktree](https://mux.coder.com/runtime/worktree.html)**: git worktrees on your local machine
  - **[SSH](https://mux.coder.com/runtime/ssh.html)**: remote execution on a server over SSH
- **Multi-model** (`sonnet-4-*`, `grok-*`, `gpt-5-*`, `opus-4-*`)
  - Ollama supported for local LLMs ([docs](https://mux.coder.com/models.html#ollama-local))
  - OpenRouter supported for long-tail of LLMs ([docs](https://mux.coder.com/models.html#openrouter-cloud))
- **VS Code Extension**: Jump into mux workspaces directly from VS Code ([docs](https://mux.coder.com/vscode-extension.html))
- Supporting UI and keybinds for efficiently managing a suite of agents
- Rich markdown outputs (mermaid diagrams, LaTeX, etc.)

mux has a custom agent loop but much of the core UX is inspired by Claude Code. You'll find familiar features like Plan/Exec mode, vim inputs, `/compact` and new ones
like [opportunistic compaction](https://mux.coder.com/context-management.html) and [mode prompts](https://mux.coder.com/instruction-files.html#mode-prompts).

**[Read the full documentation →](https://mux.coder.com)**

## Install

> [!WARNING]  
> mux is in Beta. You may encounter bugs and performance issues.
> It's still possible to be highly productive. We are using it almost exclusively for our own development.

Download pre-built binaries from [the releases page](https://github.com/coder/mux/releases) for
macOS and Linux.

[More on installation →](https://mux.coder.com/install.html)

## Screenshots

<div align="center">
  <p><em>Integrated code-review for faster iteration:</p>
  <img src="./docs/img/code-review.webp" alt="Screenshot of code review" />
</div>

<div align="center">
  <p><em>Agents report their status through the sidebar:</em></p>
  <img src="./docs/img/agent-status.webp" alt="Screenshot of agent status" />
</div>

<div align="center">
  <p><em>Git divergence UI keeps you looped in on changes and potential conflicts:</em></p>
  <img src="./docs/img/git-status.webp" alt="Screenshot of git status" />
</div>

<div align="center">
  <p><em>Mermaid diagrams make it easier to review complex proposals from the Agent:</em></p>
  <img src="./docs/img/plan-mermaid.webp" alt="Screenshot of mermaid diagram" />
</div>

<div align="center">
  <p><em>Project secrets help split your Human and Agent identities:</em></p>
  <img src="./docs/img/project-secrets.webp" alt="Screenshot of project secrets" />
</div>

<div align="center">
  <p><em>Stay looped in on costs and token consumption:</em></p>
  <img src="./docs/img/costs-tab.webp" alt="Screenshot of costs table" />
</div>

<div align="center">
  <p><em>Opportunistic compaction helps keep context small:</em></p>
  <img src="./docs/img/opportunistic-compaction.webp" alt="Screenshot of opportunistic compaction" />
</div>

## More reading

See [the documentation](https://mux.coder.com) for more details.

## Development

See [AGENTS.md](./AGENTS.md) for development setup and guidelines.

## License

Copyright (C) 2025 Coder Technologies, Inc.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, version 3 of the License.

See [LICENSE](./LICENSE) for details.
