---
title: Install
description: Download and install mux for macOS, Linux, and Windows
---

## Downloads

### Release Builds

Download pre-built binaries from [the releases page](https://github.com/coder/mux/releases):

- **macOS**: Signed and notarized DMG (separate builds for Intel/Apple Silicon)
- **Linux**: AppImage
- **Windows** _(alpha)_: Installer exe

### Development Builds

Download pre-built binaries of `main` from [GitHub Actions](https://github.com/coder/mux/actions/workflows/build.yml):

- **macOS**: Signed and notarized DMG
  - `macos-dmg-x64` (Intel Macs)
  - `macos-dmg-arm64` (Apple Silicon)
- **Linux**: AppImage (portable, works on most distros)

<Info>
  Windows builds are only available from [releases](https://github.com/coder/mux/releases), not from
  development builds.
</Info>

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

**Linux:**

1. Download the AppImage file
2. Make it executable: `chmod +x Mux-*.AppImage`
3. Run it: `./Mux-*.AppImage`

**Windows** _(alpha)_:

1. Download the installer exe from [releases](https://github.com/coder/mux/releases) (e.g., `mux-x.x.x-x64.exe`)
2. Run the installer
3. Follow the installation prompts
4. Launch Mux from the Start menu or desktop shortcut

<Warning>
  Windows support is currently in alpha. Please [report any
  issues](https://github.com/coder/mux/issues) you encounter.
</Warning>

### Testing Pre-Release Builds

<Warning>
  Only builds from the `main` branch are signed and notarized. If you're testing a build from a pull
  request or other branch, you'll need to bypass macOS Gatekeeper:
</Warning>

1. After installing, open Terminal
2. Run: `xattr -cr /Applications/Mux.app`
3. Run: `codesign --force --deep --sign - /Applications/Mux.app`
4. Now you can open the app normally
