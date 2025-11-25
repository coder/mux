# Change Log

All notable changes to the "mux" extension will be documented in this file.

## [0.1.0] - 2024-11-11

### Added

- Initial release
- Command to open mux workspaces from VS Code and Cursor
- Support for local workspaces
- Support for SSH workspaces via Remote-SSH extension
  - Automatically detects VS Code Remote-SSH (`ms-vscode-remote.remote-ssh`)
  - Automatically detects Cursor Remote-SSH (`anysphere.remote-ssh`)
- Smart workspace detection and display
- Error handling and user guidance for SSH setup
- Extension runs locally (UI-only) so it's available in all contexts (local and remote SSH workspaces)
- Documentation for setting custom keyboard shortcuts
