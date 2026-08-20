import { describe, expect, test } from "bun:test";
import { AppInfo as ElectronBuilderAppInfo } from "app-builder-lib/out/appInfo";
import packageJson from "../../../package.json";
import legacyPackageJson from "../../../packages/mux-compat/package.json";
import vscodePackageJson from "../../../vscode/package.json";
import { resolveMacPackagedAppNames } from "./macPackagedApp";

interface PackagedAppInfo {
  productFilename: string;
  productName: string;
}

// Runtime AppInfo only needs metadata+config; the published types require Packager.
const AppInfo = ElectronBuilderAppInfo as unknown as new (
  info: {
    metadata: { name: string; version: string; description?: string };
    config: { productName?: string; executableName?: string | null };
  },
  buildVersion: null
) => PackagedAppInfo;

const LOWERCASE_ARTIFACT_TEMPLATE = "${name}-${version}-${arch}.${ext}";

function expandArtifactName(arch: string, ext: string): string {
  return LOWERCASE_ARTIFACT_TEMPLATE.replaceAll("${name}", packageJson.name)
    .replaceAll("${version}", packageJson.version)
    .replaceAll("${arch}", arch)
    .replaceAll("${ext}", ext);
}

describe("shux package transition contract", () => {
  test("ships one canonical CLI implementation through both command names", () => {
    expect(packageJson.name).toBe("shux");
    expect(packageJson.bin).toEqual({
      shux: "dist/cli/index.js",
      mux: "dist/cli/index.js",
    });
  });

  test("retains install identity and the legacy deep-link scheme", () => {
    expect(packageJson.build.appId).toBe("com.mux.app");
    expect(packageJson.build.productName).toBe("Shux");
    expect(packageJson.build.executableName).toBe(packageJson.name);
    expect(packageJson.build.protocols[0]?.schemes).toEqual(["shux", "mux"]);
  });

  test("names the macOS bundle from executableName via electron-builder productFilename", () => {
    const names = resolveMacPackagedAppNames(packageJson.build);
    const appInfo = new AppInfo(
      {
        metadata: {
          name: packageJson.name,
          version: packageJson.version,
          description: packageJson.description,
        },
        config: packageJson.build,
      },
      null
    );

    expect(names.productFilename).toBe(packageJson.build.executableName);
    expect(names.appBundleName).toBe(`${packageJson.build.executableName}.app`);
    expect(names.productFilename).not.toBe(packageJson.build.productName);
    expect(appInfo.productFilename).toBe(names.productFilename);
    expect(appInfo.productName).toBe(packageJson.build.productName);

    const withoutExecutableName = new AppInfo(
      {
        metadata: {
          name: packageJson.name,
          version: packageJson.version,
          description: packageJson.description,
        },
        config: { productName: packageJson.build.productName },
      },
      null
    );
    expect(withoutExecutableName.productFilename).toBe(packageJson.build.productName);
    expect(
      resolveMacPackagedAppNames({ productName: packageJson.build.productName }).productFilename
    ).toBe(withoutExecutableName.productFilename);
  });

  test("publishes lowercase slug artifacts instead of productName filenames", () => {
    expect(packageJson.build.mac.artifactName).toBe(LOWERCASE_ARTIFACT_TEMPLATE);
    expect(packageJson.build.linux.artifactName).toBe(LOWERCASE_ARTIFACT_TEMPLATE);
    expect(packageJson.build.win.artifactName).toBe(LOWERCASE_ARTIFACT_TEMPLATE);

    const expanded = expandArtifactName("arm64", "dmg");
    expect(expanded.startsWith(`${packageJson.name}-`)).toBe(true);
    expect(expanded).toBe(`${packageJson.name}-${packageJson.version}-arm64.dmg`);
    expect(expanded.startsWith(`${packageJson.build.productName}-`)).toBe(false);
  });

  test("keeps the Linux desktop name visible while WM class follows the slug", () => {
    expect(packageJson.build.linux.desktop?.StartupWMClass).toBe(packageJson.name);
    expect(packageJson.build.linux.desktop).not.toHaveProperty("Name");
  });

  test("keeps the published mux forwarding package version-locked to shux", () => {
    expect(legacyPackageJson.name).toBe("mux");
    expect(legacyPackageJson.version).toBe(packageJson.version);
    expect(legacyPackageJson.dependencies.shux).toBe(packageJson.version);
  });

  test("keeps the VS Code Marketplace identity on mux while showing Shux", () => {
    expect(vscodePackageJson.name).toBe("mux");
    expect(vscodePackageJson.publisher).toBe("coder");
    expect(vscodePackageJson.displayName).toBe(packageJson.build.productName);
  });
});
