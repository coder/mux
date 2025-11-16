# Install

## Downloads

### Release Builds

Download pre-built binaries from [the releases page](https://github.com/coder/mux/releases):

- **macOS**: Signed and notarized DMG (separate builds for Intel/Apple Silicon)
- **Linux**: AppImage
- **Windows**: Signed installer (.exe)

### Development Builds

Download pre-built binaries of `main` from [GitHub Actions](https://github.com/coder/mux/actions/workflows/build.yml):

- **macOS**: Signed and notarized DMG
  - `macos-dmg-x64` (Intel Macs)
  - `macos-dmg-arm64` (Apple Silicon)
- **Linux**: AppImage (portable, works on most distros)
- **Windows**: Installer (.exe) – artifact `windows-installer`

To download:

1. Go to the [Build workflow](https://github.com/coder/mux/actions/workflows/build.yml?query=event:merge_group)
2. Click on the latest successful run
3. Scroll down to "Artifacts" section
4. Download the appropriate artifact for your platform

### Installation

**macOS:**

1. Download the DMG file for your Mac:
   - Intel Mac: `macos-dmg-x64`
   - Apple Silicon: `macos-dmg-arm64`
2. Open the DMG file
3. Drag Mux to Applications folder
4. Open the app normally

The app is code-signed and notarized by Apple, so it will open without security warnings.

**Windows:**

1. Download the `.exe` installer from the release page or the `windows-installer` artifact.
2. Double-click the installer and follow the prompts. The installer places Mux in `%LOCALAPPDATA%\Programs\mux` and adds a Start Menu entry.
3. If SmartScreen warns about the binary (common for unsigned preview builds), click **More info** → **Run anyway**.
4. Launch Mux from the Start Menu or run `mux.exe --server` from PowerShell to start the browser-accessible server mode directly.

**Linux:**

1. Download the AppImage file
2. Make it executable: `chmod +x Mux-*.AppImage`
3. Run it: `./Mux-*.AppImage`

### Running Mux in server mode

Mux includes a lightweight server mode so you can keep the agent running without the desktop shell and reach it from any browser (desktop, tablet, or phone). After installing, run `mux --server` (or `mux.exe --server` on Windows) to start an HTTP/WebSocket control plane.

- The server hosts the full Mux UI over the web and prints a URL such as `http://localhost:3000`. Open that URL from the same machine, or expose it via a tunnel/VPN to reach it from mobile devices.
- Use `--host 0.0.0.0` to bind to all interfaces and `--port <number>` to pick a different port.
- Pass `--add-project /path/to/repo` to register and auto-open a workspace when the browser connects.

This mode is ideal for mobile development: keep the heavy Electron app on a workstation, run `mux --server`, and interact with the session from your phone or tablet browser.

### Testing Pre-Release Builds

⚠️ **Note**: Only builds from the `main` branch are signed and notarized. If you're testing a build from a pull request or other branch, you'll need to bypass macOS Gatekeeper:

1. After installing, open Terminal
2. Run: `xattr -cr /Applications/Mux.app`
3. Run: `codesign --force --deep --sign - /Applications/Mux.app`
4. Now you can open the app normally
