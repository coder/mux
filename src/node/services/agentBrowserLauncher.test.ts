import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  AgentBrowserBinaryNotFoundError,
  generateAgentBrowserWrapper,
  getVendoredBinDir,
  rewriteAsarPath,
  resolveAgentBrowserBinary,
} from "./agentBrowserLauncher";

function normalizeExpectedArch(arch: string): string {
  switch (arch) {
    case "x64":
    case "x86_64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return arch;
  }
}

afterEach(() => {
  mock.restore();
});

describe("rewriteAsarPath", () => {
  test("rewrites packaged Electron app.asar paths to app.asar.unpacked", () => {
    expect(
      rewriteAsarPath(
        "/Applications/Mux.app/Contents/Resources/app.asar/node_modules/agent-browser/bin"
      )
    ).toBe(
      "/Applications/Mux.app/Contents/Resources/app.asar.unpacked/node_modules/agent-browser/bin"
    );
  });

  test("leaves non-ASAR paths unchanged", () => {
    const originalPath = "/tmp/node_modules/agent-browser/bin/agent-browser-darwin-arm64";

    expect(rewriteAsarPath(originalPath)).toBe(originalPath);
  });
});

describe("resolveAgentBrowserBinary", () => {
  test("returns an absolute existing binary path for the current supported runtime", () => {
    const resolvedBinaryPath = resolveAgentBrowserBinary();
    const expectedArch = normalizeExpectedArch(process.arch);

    expect(resolvedBinaryPath.length).toBeGreaterThan(0);
    expect(path.isAbsolute(resolvedBinaryPath)).toBe(true);
    expect(resolvedBinaryPath).toContain(`agent-browser-${process.platform}-${expectedArch}`);
    expect(existsSync(resolvedBinaryPath)).toBe(true);
  });

  test("throws a descriptive error when the vendored package cannot be resolved", () => {
    expect(() =>
      resolveAgentBrowserBinary({
        resolvePackageJsonPath() {
          throw new Error("module not found");
        },
      })
    ).toThrow(/vendored agent-browser package not found/i);
  });

  test("throws a descriptive error for unsupported platform and arch combinations", () => {
    expect(() =>
      resolveAgentBrowserBinary({
        platform: "sunos",
        arch: "sparc",
      })
    ).toThrow(/unsupported vendored agent-browser platform\/arch combination/i);
  });

  test("throws a dedicated missing-binary error when the expected native executable is absent", async () => {
    const tempPackageRoot = await mkdtemp(
      path.join(os.tmpdir(), "mux-agent-browser-launcher-test-")
    );

    try {
      const fakePackageJsonPath = path.join(tempPackageRoot, "package.json");
      await writeFile(fakePackageJsonPath, JSON.stringify({ name: "agent-browser" }), "utf8");

      expect(() =>
        resolveAgentBrowserBinary({
          platform: "linux",
          arch: "x64",
          resolvePackageJsonPath: () => fakePackageJsonPath,
        })
      ).toThrow(AgentBrowserBinaryNotFoundError);
    } finally {
      await rm(tempPackageRoot, { recursive: true, force: true });
    }
  });
});

describe("getVendoredBinDir", () => {
  test("returns an absolute mux-managed bin directory path", () => {
    const vendoredBinDir = getVendoredBinDir();

    expect(path.isAbsolute(vendoredBinDir)).toBe(true);
    expect(vendoredBinDir.endsWith(path.join("", "bin"))).toBe(true);
  });
});

describe("generateAgentBrowserWrapper", () => {
  test("generates wrapper scripts that invoke the resolved absolute binary path", () => {
    const resolvedBinaryPath = resolveAgentBrowserBinary();
    const wrapper = generateAgentBrowserWrapper();

    expect(wrapper.dir).toBe(getVendoredBinDir());
    expect(wrapper.posixContent.startsWith("#!/bin/sh\n")).toBe(true);
    expect(wrapper.posixContent).toContain("mux_has_session_arg=0");
    expect(wrapper.posixContent).toContain("MUX_BROWSER_SESSION");
    expect(wrapper.posixContent).toContain('--session "$MUX_BROWSER_SESSION"');
    expect(wrapper.posixContent).toContain(resolvedBinaryPath);
    expect(wrapper.posixContent).toContain('"$@"');
    expect(wrapper.windowsContent).toContain("EnableDelayedExpansion");
    expect(wrapper.windowsContent).toContain("MUX_BROWSER_SESSION");
    expect(wrapper.windowsContent).toContain("for %%A in (%*) do");
    expect(wrapper.windowsContent).toContain('set "MUX_CURRENT_ARG=%%~A"');
    expect(wrapper.windowsContent).toContain('if /I "!MUX_CURRENT_ARG!"=="--session"');
    expect(wrapper.windowsContent).toContain('if /I "!MUX_CURRENT_ARG:~0,10!"=="--session="');
    expect(wrapper.windowsContent).not.toContain("findstr");
    expect(wrapper.windowsContent).not.toContain("echo(");
    expect(wrapper.windowsContent).toContain('--session "%MUX_BROWSER_SESSION%"');
    expect(wrapper.windowsContent).toContain("exit /B !ERRORLEVEL!");
    expect(wrapper.windowsContent).toContain(resolvedBinaryPath);
    expect(wrapper.windowsContent).toContain("%*");
    expect(path.isAbsolute(resolvedBinaryPath)).toBe(true);
  });
});
