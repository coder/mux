# mux VS Code Extension

Open [mux](https://mux.coder.com) workspaces from VS Code or Cursor.

## Installation

Download the latest `.vsix` from [mux releases](https://github.com/coder/mux/releases) and install:

```bash
code --install-extension mux-0.1.0.vsix
```

## Usage

`Cmd+Shift+P` → "mux: Open Workspace" → Select workspace

## Requirements

**For SSH workspaces**: Install Remote-SSH extension

- **VS Code**: `ms-vscode-remote.remote-ssh`
- **Cursor**: `anysphere.remote-ssh`

SSH hosts must be configured in `~/.ssh/config`.

## Development

```bash
cd vscode
npm install
npm run compile  # Build
npm run package  # Create .vsix
```

Press `F5` in VS Code to debug.
