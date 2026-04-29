import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { DockerRuntime } from "@/node/runtime/DockerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import {
  getManagedLspToolsDir,
  probeWorkspaceLocalExecutable,
  probeWorkspaceLocalExecutableForWorkspace,
} from "./lspLaunchProvisioning";
import { getPathCommandEnv, resolveLspLaunchPlan } from "./lspLaunchResolver";
import type { LspPolicyContext, LspServerDescriptor } from "./types";

const TRUSTED_MANUAL_POLICY_CONTEXT: LspPolicyContext = {
  provisioningMode: "manual",
  trustedWorkspaceExecution: true,
};
const TRUSTED_AUTO_POLICY_CONTEXT: LspPolicyContext = {
  provisioningMode: "auto",
  trustedWorkspaceExecution: true,
};
const UNTRUSTED_AUTO_POLICY_CONTEXT: LspPolicyContext = {
  provisioningMode: "auto",
  trustedWorkspaceExecution: false,
};

function createManualDescriptor(command: string): LspServerDescriptor {
  return {
    id: "typescript",
    extensions: [".ts"],
    launch: {
      type: "manual",
      command,
      args: ["--stdio"],
    },
    rootMarkers: ["package.json", ".git"],
    languageIdForPath: () => "typescript",
  };
}

function prependToPath(entry: string): string {
  return [entry, process.env.PATH]
    .filter((value): value is string => value != null && value.length > 0)
    .join(path.delimiter);
}

async function writeExecutable(filePath: string, script: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, script);
  await fs.chmod(filePath, 0o755);
}

describe("resolveLspLaunchPlan", () => {
  let workspacePath: string;
  let runtime: LocalRuntime;
  let binDir: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-launch-"));
    runtime = new LocalRuntime(workspacePath);
    binDir = path.join(workspacePath, "tools", "bin");

    await fs.mkdir(path.join(workspacePath, "subdir"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "package.json"), "{}\n");
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("resolves explicit relative executables and launch cwd before client creation", async () => {
    await writeExecutable(
      path.join(workspacePath, "tools", "bin", "fake-lsp"),
      "#!/bin/sh\nexit 0\n"
    );

    const descriptor: LspServerDescriptor = {
      ...createManualDescriptor("../tools/bin/fake-lsp"),
      launch: {
        type: "manual",
        command: "../tools/bin/fake-lsp",
        args: ["--stdio"],
        cwd: "./subdir",
        env: { LSP_TRACE: "verbose" },
        initializationOptions: { preferences: { quoteStyle: "single" } },
      },
    };

    const launchPlan = await resolveLspLaunchPlan({
      descriptor,
      runtime,
      rootPath: workspacePath,
      policyContext: TRUSTED_MANUAL_POLICY_CONTEXT,
    });

    expect(launchPlan).toEqual({
      command: path.join(workspacePath, "tools", "bin", "fake-lsp"),
      args: ["--stdio"],
      cwd: path.join(workspacePath, "subdir"),
      env: { LSP_TRACE: "verbose" },
      initializationOptions: { preferences: { quoteStyle: "single" } },
    });
  });

  it("prefers trusted workspace-local TypeScript server and injects project tsserver path", async () => {
    await writeExecutable(
      path.join(workspacePath, "node_modules", ".bin", "typescript-language-server"),
      "#!/bin/sh\nexit 0\n"
    );
    await fs.mkdir(path.join(workspacePath, "node_modules", "typescript", "lib"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspacePath, "node_modules", "typescript", "lib", "tsserver.js"),
      "module.exports = {};\n"
    );
    await writeExecutable(path.join(binDir, "typescript-language-server"), "#!/bin/sh\nexit 0\n");

    const launchPlan = await resolveLspLaunchPlan({
      descriptor: {
        id: "typescript",
        extensions: [".ts"],
        launch: {
          type: "provisioned",
          args: ["--stdio"],
          env: { PATH: prependToPath(binDir) },
          workspaceTsserverPathCandidates: ["node_modules/typescript/lib"],
          strategies: [
            {
              type: "workspaceLocalExecutable",
              relativeCandidates: ["node_modules/.bin/typescript-language-server"],
            },
            { type: "pathCommand", command: "typescript-language-server" },
          ],
        },
        rootMarkers: ["package.json", ".git"],
        languageIdForPath: () => "typescript",
      },
      runtime,
      rootPath: workspacePath,
      policyContext: TRUSTED_MANUAL_POLICY_CONTEXT,
    });

    expect(launchPlan.command).toBe(
      path.join(workspacePath, "node_modules", ".bin", "typescript-language-server")
    );
    expect(launchPlan.args).toEqual(["--stdio"]);
    expect(launchPlan.initializationOptions).toEqual({
      tsserver: {
        path: path.join(workspacePath, "node_modules", "typescript", "lib"),
      },
    });
  });

  it("skips workspace-local probes for untrusted workspaces and falls back to a sanitized PATH", async () => {
    const externalBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-global-bin-"));
    try {
      await writeExecutable(
        path.join(workspacePath, "node_modules", ".bin", "typescript-language-server"),
        "#!/bin/sh\nexit 0\n"
      );
      await fs.mkdir(path.join(workspacePath, "node_modules", "typescript", "lib"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(workspacePath, "node_modules", "typescript", "lib", "tsserver.js"),
        "module.exports = {};\n"
      );
      await writeExecutable(
        path.join(externalBinDir, "typescript-language-server"),
        "#!/bin/sh\nexit 0\n"
      );

      const launchPlan = await resolveLspLaunchPlan({
        descriptor: {
          id: "typescript",
          extensions: [".ts"],
          launch: {
            type: "provisioned",
            args: ["--stdio"],
            env: {
              PATH: ["node_modules/.bin", prependToPath(externalBinDir)]
                .filter((value) => value.length > 0)
                .join(path.delimiter),
            },
            workspaceTsserverPathCandidates: ["node_modules/typescript/lib"],
            strategies: [
              {
                type: "workspaceLocalExecutable",
                relativeCandidates: ["node_modules/.bin/typescript-language-server"],
              },
              { type: "pathCommand", command: "typescript-language-server" },
            ],
          },
          rootMarkers: ["package.json", ".git"],
          languageIdForPath: () => "typescript",
        },
        runtime,
        rootPath: workspacePath,
        policyContext: UNTRUSTED_AUTO_POLICY_CONTEXT,
      });

      expect(launchPlan.command).toBe(path.join(externalBinDir, "typescript-language-server"));
      expect(launchPlan.env).toEqual({ PATH: prependToPath(externalBinDir) });
      expect(launchPlan.initializationOptions).toBeUndefined();
    } finally {
      await fs.rm(externalBinDir, { recursive: true, force: true });
    }
  });

  it("uses an explicit sanitized inherited PATH for untrusted pathCommand launches", async () => {
    const externalBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-global-bin-"));
    const workspaceBinDir = path.join(workspacePath, "node_modules", ".bin");
    const originalPath = process.env.PATH;

    try {
      await writeExecutable(
        path.join(workspaceBinDir, "mux-untrusted-path-command"),
        "#!/bin/sh\nexit 0\n"
      );
      await writeExecutable(
        path.join(externalBinDir, "mux-untrusted-path-command"),
        "#!/bin/sh\nexit 0\n"
      );

      process.env.PATH = [workspaceBinDir, externalBinDir, originalPath]
        .filter((value): value is string => value != null && value.length > 0)
        .join(path.delimiter);

      const launchPlan = await resolveLspLaunchPlan({
        descriptor: {
          id: "typescript",
          extensions: [".ts"],
          launch: {
            type: "provisioned",
            args: ["--stdio"],
            env: { LSP_TRACE: "verbose" },
            strategies: [{ type: "pathCommand", command: "mux-untrusted-path-command" }],
          },
          rootMarkers: ["package.json", ".git"],
          languageIdForPath: () => "typescript",
        },
        runtime,
        rootPath: workspacePath,
        policyContext: UNTRUSTED_AUTO_POLICY_CONTEXT,
      });

      expect(launchPlan.command).toBe(path.join(externalBinDir, "mux-untrusted-path-command"));
      expect(launchPlan.env).toEqual({
        LSP_TRACE: "verbose",
        PATH: [externalBinDir, originalPath]
          .filter((value): value is string => value != null && value.length > 0)
          .join(path.delimiter),
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await fs.rm(externalBinDir, { recursive: true, force: true });
    }
  });

  it("keeps a sanitized PATH override for untrusted pathCommand launches without explicit env", async () => {
    const externalBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-global-bin-"));
    const workspaceBinDir = path.join(workspacePath, "node_modules", ".bin");
    const originalPath = process.env.PATH;

    try {
      await writeExecutable(
        path.join(workspaceBinDir, "mux-inherited-path-command"),
        "#!/bin/sh\nexit 0\n"
      );
      await writeExecutable(
        path.join(externalBinDir, "mux-inherited-path-command"),
        "#!/bin/sh\nexit 0\n"
      );

      process.env.PATH = [workspaceBinDir, externalBinDir, originalPath]
        .filter((value): value is string => value != null && value.length > 0)
        .join(path.delimiter);

      const launchPlan = await resolveLspLaunchPlan({
        descriptor: {
          id: "typescript",
          extensions: [".ts"],
          launch: {
            type: "provisioned",
            args: ["--stdio"],
            strategies: [{ type: "pathCommand", command: "mux-inherited-path-command" }],
          },
          rootMarkers: ["package.json", ".git"],
          languageIdForPath: () => "typescript",
        },
        runtime,
        rootPath: workspacePath,
        policyContext: UNTRUSTED_AUTO_POLICY_CONTEXT,
      });

      expect(launchPlan.command).toBe(path.join(externalBinDir, "mux-inherited-path-command"));
      expect(launchPlan.env).toEqual({
        PATH: [externalBinDir, originalPath]
          .filter((value): value is string => value != null && value.length > 0)
          .join(path.delimiter),
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await fs.rm(externalBinDir, { recursive: true, force: true });
    }
  });

  it("sanitizes untrusted inherited PATH entries from the full workspace for nested package roots", async () => {
    const packageRoot = path.join(workspacePath, "apps", "web");
    const externalBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-global-bin-"));
    const repoBinDir = path.join(workspacePath, "node_modules", ".bin");
    const originalPath = process.env.PATH;

    try {
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.writeFile(path.join(packageRoot, "package.json"), "{}\n");
      await writeExecutable(
        path.join(repoBinDir, "mux-nested-path-command"),
        "#!/bin/sh\nexit 0\n"
      );
      await writeExecutable(
        path.join(externalBinDir, "mux-nested-path-command"),
        "#!/bin/sh\nexit 0\n"
      );

      process.env.PATH = [repoBinDir, externalBinDir, originalPath]
        .filter((value): value is string => value != null && value.length > 0)
        .join(path.delimiter);

      const launchPlan = await resolveLspLaunchPlan({
        descriptor: {
          id: "typescript",
          extensions: [".ts"],
          launch: {
            type: "provisioned",
            args: ["--stdio"],
            strategies: [{ type: "pathCommand", command: "mux-nested-path-command" }],
          },
          rootMarkers: ["package.json", ".git"],
          languageIdForPath: () => "typescript",
        },
        runtime,
        rootPath: packageRoot,
        workspacePath,
        policyContext: UNTRUSTED_AUTO_POLICY_CONTEXT,
      });

      expect(launchPlan.command).toBe(path.join(externalBinDir, "mux-nested-path-command"));
      expect(launchPlan.env).toEqual({
        PATH: [externalBinDir, originalPath]
          .filter((value): value is string => value != null && value.length > 0)
          .join(path.delimiter),
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await fs.rm(externalBinDir, { recursive: true, force: true });
    }
  });

  it("sanitizes untrusted PATH env only for local and worktree runtimes", async () => {
    const externalBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-global-bin-"));
    const workspaceBinDir = path.join(workspacePath, "node_modules", ".bin");
    const explicitPath = [workspaceBinDir, externalBinDir]
      .filter((value) => value.length > 0)
      .join(path.delimiter);
    const expectedSanitizedPath = externalBinDir;

    try {
      const localEnv = getPathCommandEnv(
        runtime,
        workspacePath,
        { LSP_TRACE: "verbose", PATH: explicitPath },
        UNTRUSTED_AUTO_POLICY_CONTEXT
      );
      expect(localEnv).toEqual({
        LSP_TRACE: "verbose",
        PATH: expectedSanitizedPath,
      });

      const worktreeEnv = getPathCommandEnv(
        new WorktreeRuntime(os.tmpdir()),
        workspacePath,
        { LSP_TRACE: "verbose", PATH: explicitPath },
        UNTRUSTED_AUTO_POLICY_CONTEXT
      );
      expect(worktreeEnv).toEqual({
        LSP_TRACE: "verbose",
        PATH: expectedSanitizedPath,
      });

      const wrappedWorktreeEnv = getPathCommandEnv(
        new MultiProjectRuntime(
          new ContainerManager(os.tmpdir()),
          [
            {
              projectPath: workspacePath,
              projectName: "project",
              runtime: new WorktreeRuntime(os.tmpdir()),
            },
          ],
          "shared-workspace"
        ),
        workspacePath,
        { LSP_TRACE: "verbose", PATH: explicitPath },
        UNTRUSTED_AUTO_POLICY_CONTEXT
      );
      expect(wrappedWorktreeEnv).toEqual({
        LSP_TRACE: "verbose",
        PATH: expectedSanitizedPath,
      });

      const remotePath = ["node_modules/.bin", "/usr/local/bin"].join(path.delimiter);
      const remoteEnv = { LSP_TRACE: "verbose", PATH: remotePath };

      const wrappedDockerEnv = getPathCommandEnv(
        new MultiProjectRuntime(
          new ContainerManager(os.tmpdir()),
          [
            {
              projectPath: workspacePath,
              projectName: "project",
              runtime: new DockerRuntime({ image: "node:20", containerName: "mux-lsp-test" }),
            },
          ],
          "shared-workspace"
        ),
        workspacePath,
        remoteEnv,
        UNTRUSTED_AUTO_POLICY_CONTEXT
      );
      expect(wrappedDockerEnv).toEqual(remoteEnv);

      const devcontainerEnv = getPathCommandEnv(
        new DevcontainerRuntime({
          srcBaseDir: os.tmpdir(),
          configPath: path.join(workspacePath, ".devcontainer", "devcontainer.json"),
        }),
        workspacePath,
        remoteEnv,
        UNTRUSTED_AUTO_POLICY_CONTEXT
      );
      expect(devcontainerEnv).toEqual(remoteEnv);

      const dockerEnv = getPathCommandEnv(
        new DockerRuntime({ image: "node:20", containerName: "mux-lsp-test" }),
        workspacePath,
        remoteEnv,
        UNTRUSTED_AUTO_POLICY_CONTEXT
      );
      expect(dockerEnv).toEqual(remoteEnv);
    } finally {
      await fs.rm(externalBinDir, { recursive: true, force: true });
    }
  });

  it("orders package-manager execution using repo signals", async () => {
    await writeExecutable(path.join(binDir, "bunx"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(path.join(binDir, "pnpm"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(path.join(binDir, "npm"), "#!/bin/sh\nexit 0\n");
    await fs.writeFile(
      path.join(workspacePath, "package.json"),
      JSON.stringify({ packageManager: "bun@1.2.0" })
    );
    await fs.writeFile(path.join(workspacePath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const launchPlan = await resolveLspLaunchPlan({
      descriptor: {
        id: "typescript",
        extensions: [".ts"],
        launch: {
          type: "provisioned",
          args: ["--stdio"],
          env: { PATH: prependToPath(binDir) },
          strategies: [
            {
              type: "nodePackageExec",
              packageName: "typescript-language-server",
              binaryName: "typescript-language-server",
            },
          ],
        },
        rootMarkers: ["package.json", ".git"],
        languageIdForPath: () => "typescript",
      },
      runtime,
      rootPath: workspacePath,
      policyContext: TRUSTED_AUTO_POLICY_CONTEXT,
    });

    expect(launchPlan).toEqual({
      command: path.join(binDir, "bunx"),
      args: ["--package", "typescript-language-server", "typescript-language-server", "--stdio"],
      cwd: workspacePath,
      env: { PATH: prependToPath(binDir) },
      initializationOptions: undefined,
    });
  });

  it("finds ancestor TypeScript metadata and package-manager hints for nested package roots", async () => {
    const packageRoot = path.join(workspacePath, "web", "packages", "teleport");
    const repoTypescriptLib = path.join(workspacePath, "node_modules", "typescript", "lib");

    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), "{}\n");
    await fs.writeFile(
      path.join(workspacePath, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.0.0" })
    );
    await fs.writeFile(path.join(workspacePath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.mkdir(repoTypescriptLib, { recursive: true });
    await fs.writeFile(path.join(repoTypescriptLib, "tsserver.js"), "module.exports = {};\n");
    await writeExecutable(path.join(binDir, "pnpm"), "#!/bin/sh\nexit 0\n");

    const launchPlan = await resolveLspLaunchPlan({
      descriptor: {
        id: "typescript",
        extensions: [".ts"],
        launch: {
          type: "provisioned",
          args: ["--stdio"],
          env: { PATH: prependToPath(binDir) },
          workspaceTsserverPathCandidates: ["node_modules/typescript/lib"],
          strategies: [
            {
              type: "nodePackageExec",
              packageName: "typescript-language-server",
              binaryName: "typescript-language-server",
              fallbackPackageNames: ["typescript"],
            },
          ],
        },
        rootMarkers: ["package.json", ".git"],
        languageIdForPath: () => "typescript",
      },
      runtime,
      rootPath: packageRoot,
      workspacePath,
      policyContext: TRUSTED_AUTO_POLICY_CONTEXT,
    });

    expect(launchPlan).toEqual({
      command: path.join(binDir, "pnpm"),
      args: [
        "--package",
        "typescript-language-server",
        "dlx",
        "typescript-language-server",
        "--stdio",
      ],
      cwd: packageRoot,
      env: { PATH: prependToPath(binDir) },
      initializationOptions: {
        tsserver: {
          path: repoTypescriptLib,
        },
      },
    });
  });

  it("adds a fallback TypeScript package when package-manager exec has no ancestor tsserver", async () => {
    const packageRoot = path.join(workspacePath, "web", "packages", "teleport");

    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), "{}\n");
    await fs.writeFile(path.join(workspacePath, "package.json"), "{}\n");
    await fs.writeFile(path.join(workspacePath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeExecutable(path.join(binDir, "pnpm"), "#!/bin/sh\nexit 0\n");

    const launchPlan = await resolveLspLaunchPlan({
      descriptor: {
        id: "typescript",
        extensions: [".ts"],
        launch: {
          type: "provisioned",
          args: ["--stdio"],
          env: { PATH: prependToPath(binDir) },
          workspaceTsserverPathCandidates: ["node_modules/typescript/lib"],
          strategies: [
            {
              type: "nodePackageExec",
              packageName: "typescript-language-server",
              binaryName: "typescript-language-server",
              fallbackPackageNames: ["typescript"],
            },
          ],
        },
        rootMarkers: ["package.json", ".git"],
        languageIdForPath: () => "typescript",
      },
      runtime,
      rootPath: packageRoot,
      workspacePath,
      policyContext: TRUSTED_AUTO_POLICY_CONTEXT,
    });

    expect(launchPlan).toEqual({
      command: path.join(binDir, "pnpm"),
      args: [
        "--package",
        "typescript-language-server",
        "--package",
        "typescript",
        "dlx",
        "typescript-language-server",
        "--stdio",
      ],
      cwd: packageRoot,
      env: { PATH: prependToPath(binDir) },
      initializationOptions: undefined,
    });
  });

  it("disables automatic provisioning strategies for untrusted workspaces", async () => {
    try {
      await resolveLspLaunchPlan({
        descriptor: {
          id: "typescript",
          extensions: [".ts"],
          launch: {
            type: "provisioned",
            env: { PATH: prependToPath(binDir) },
            strategies: [
              {
                type: "nodePackageExec",
                packageName: "typescript-language-server",
                binaryName: "typescript-language-server",
              },
            ],
          },
          rootMarkers: ["package.json", ".git"],
          languageIdForPath: () => "typescript",
        },
        runtime,
        rootPath: workspacePath,
        policyContext: UNTRUSTED_AUTO_POLICY_CONTEXT,
      });
      throw new Error("Expected untrusted package-manager provisioning to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "automatic package-manager provisioning is disabled for untrusted workspaces"
      );
    }

    try {
      await resolveLspLaunchPlan({
        descriptor: {
          id: "go",
          extensions: [".go"],
          launch: {
            type: "provisioned",
            env: { PATH: prependToPath(binDir) },
            strategies: [
              {
                type: "goManagedInstall",
                module: "golang.org/x/tools/gopls@v0.21.0",
                binaryName: "gopls",
              },
            ],
          },
          rootMarkers: ["go.mod", ".git"],
          languageIdForPath: () => "go",
        },
        runtime,
        rootPath: workspacePath,
        policyContext: UNTRUSTED_AUTO_POLICY_CONTEXT,
      });
      throw new Error("Expected untrusted managed Go provisioning to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "managed Go installs are disabled for untrusted workspaces"
      );
    }
  });

  it("gates managed gopls installs on provisioning mode and installs in auto mode", async () => {
    const installSubdirectory = ["tests", path.basename(workspacePath), "go", "bin"] as const;
    await writeExecutable(
      path.join(binDir, "go"),
      '#!/bin/sh\nmkdir -p "$GOBIN"\nprintf \'#!/bin/sh\\nexit 0\\n\' > "$GOBIN/gopls"\nchmod +x "$GOBIN/gopls"\n'
    );

    const descriptor: LspServerDescriptor = {
      id: "go",
      extensions: [".go"],
      launch: {
        type: "provisioned",
        env: { PATH: prependToPath(binDir) },
        strategies: [
          {
            type: "goManagedInstall",
            module: "golang.org/x/tools/gopls@v0.21.0",
            binaryName: "gopls",
            installSubdirectory,
          },
        ],
      },
      rootMarkers: ["go.mod", ".git"],
      languageIdForPath: () => "go",
    };

    try {
      await resolveLspLaunchPlan({
        descriptor,
        runtime,
        rootPath: workspacePath,
        policyContext: TRUSTED_MANUAL_POLICY_CONTEXT,
      });
      throw new Error("Expected manual provisioning mode to reject managed gopls installs");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("managed Go installs are disabled in manual mode");
    }

    const launchPlan = await resolveLspLaunchPlan({
      descriptor,
      runtime,
      rootPath: workspacePath,
      policyContext: TRUSTED_AUTO_POLICY_CONTEXT,
    });

    expect(launchPlan.command).toBe(
      path.join(
        await runtime.resolvePath(getManagedLspToolsDir(runtime, ...installSubdirectory)),
        "gopls"
      )
    );
    expect(launchPlan.cwd).toBe(workspacePath);
    expect(launchPlan.env).toEqual({ PATH: prependToPath(binDir) });
  });

  it("reuses an existing managed gopls binary before re-running go install", async () => {
    const installSubdirectory = [
      "tests",
      path.basename(workspacePath),
      "reused-go",
      "bin",
    ] as const;
    const managedBinDir = await runtime.resolvePath(
      getManagedLspToolsDir(runtime, ...installSubdirectory)
    );
    const goInvocationMarker = path.join(workspacePath, "go-invoked.txt");

    await writeExecutable(
      path.join(binDir, "go"),
      `#!/bin/sh\nprintf 'unexpected go install\\n' > ${JSON.stringify(goInvocationMarker)}\nexit 1\n`
    );
    await writeExecutable(path.join(managedBinDir, "gopls"), "#!/bin/sh\nexit 0\n");

    const launchPlan = await resolveLspLaunchPlan({
      descriptor: {
        id: "go",
        extensions: [".go"],
        launch: {
          type: "provisioned",
          env: { PATH: prependToPath(binDir) },
          strategies: [
            {
              type: "goManagedInstall",
              module: "golang.org/x/tools/gopls@v0.21.0",
              binaryName: "gopls",
              installSubdirectory,
            },
          ],
        },
        rootMarkers: ["go.mod", ".git"],
        languageIdForPath: () => "go",
      },
      runtime,
      rootPath: workspacePath,
      policyContext: TRUSTED_AUTO_POLICY_CONTEXT,
    });

    expect(launchPlan.command).toBe(path.join(managedBinDir, "gopls"));
    try {
      await fs.stat(goInvocationMarker);
      throw new Error("Expected managed gopls reuse to avoid re-running go install");
    } catch (error) {
      expect(error).toMatchObject({ code: "ENOENT" });
    }
  });

  it("returns unsupported errors for servers without auto-install support", async () => {
    try {
      await resolveLspLaunchPlan({
        descriptor: {
          id: "rust",
          extensions: [".rs"],
          launch: {
            type: "provisioned",
            strategies: [
              {
                type: "unsupported",
                message:
                  "rust-analyzer is not available on PATH and automatic installation is not supported yet",
              },
            ],
          },
          rootMarkers: ["Cargo.toml", ".git"],
          languageIdForPath: () => "rust",
        },
        runtime,
        rootPath: workspacePath,
        policyContext: TRUSTED_AUTO_POLICY_CONTEXT,
      });
      throw new Error("Expected rust-analyzer provisioning to report unsupported auto-install");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("automatic installation is not supported yet");
    }
  });
});

describe("lspLaunchProvisioning helpers", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-provisioning-"));
    await fs.mkdir(path.join(workspacePath, "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, "node_modules", ".bin", "fake-lsp"),
      "#!/bin/sh\nexit 0\n"
    );
    await fs.chmod(path.join(workspacePath, "node_modules", ".bin", "fake-lsp"), 0o755);
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("probes workspace-local executable candidates with either workspace locator input", async () => {
    const runtime = new LocalRuntime(workspacePath);
    const relativeCandidates = ["node_modules/.bin/fake-lsp", "vendor/bin/fake-lsp"] as const;

    expect(await probeWorkspaceLocalExecutable(runtime, workspacePath, relativeCandidates)).toBe(
      path.join(workspacePath, "node_modules", ".bin", "fake-lsp")
    );
    expect(
      await probeWorkspaceLocalExecutableForWorkspace(
        runtime,
        "/unused/project",
        "feature",
        relativeCandidates
      )
    ).toBe(path.join(workspacePath, "node_modules", ".bin", "fake-lsp"));
  });

  it("derives managed tool directories from mux home without touching PATH", () => {
    const runtime = new LocalRuntime(workspacePath);

    expect(getManagedLspToolsDir(runtime, "typescript")).toEndWith(
      path.join(".mux", "tools", "lsp", "typescript")
    );
  });
});
