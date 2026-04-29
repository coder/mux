import * as path from "node:path";
import type { LspServerDescriptor } from "./types";

function ext(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const TYPESCRIPT_TSSERVER_PATH_CANDIDATES = [
  "node_modules/typescript/lib",
  "node_modules/typescript/lib/tsserver.js",
] as const;
const GOPLS_MANAGED_INSTALL_TARGET = "golang.org/x/tools/gopls@v0.21.0";

const typescriptServer: LspServerDescriptor = {
  id: "typescript",
  extensions: TYPESCRIPT_EXTENSIONS,
  launch: {
    type: "provisioned",
    args: ["--stdio"],
    // Preserve project-local TypeScript when the workspace is trusted, even if the language server
    // itself comes from PATH or a package-manager cache. That keeps diagnostics/navigation aligned
    // with the repo's configured TypeScript version without executing untrusted repo-local binaries.
    workspaceTsserverPathCandidates: TYPESCRIPT_TSSERVER_PATH_CANDIDATES,
    strategies: [
      {
        type: "workspaceLocalExecutable",
        relativeCandidates: ["node_modules/.bin/typescript-language-server"],
      },
      {
        type: "pathCommand",
        command: "typescript-language-server",
      },
      {
        type: "nodePackageExec",
        packageName: "typescript-language-server",
        binaryName: "typescript-language-server",
        // typescript-language-server still needs a resolvable tsserver when we fall back to
        // package-manager exec, so provision TypeScript only when the workspace has none.
        fallbackPackageNames: ["typescript"],
      },
    ],
  },
  rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
  languageIdForPath(filePath: string): string {
    const fileExt = ext(filePath);
    if (fileExt === ".tsx") return "typescriptreact";
    if (fileExt === ".jsx") return "javascriptreact";
    if (fileExt === ".js" || fileExt === ".mjs" || fileExt === ".cjs") return "javascript";
    return "typescript";
  },
};

const pythonServer: LspServerDescriptor = {
  id: "python",
  extensions: [".py"],
  launch: {
    type: "provisioned",
    args: ["--stdio"],
    strategies: [
      {
        type: "pathCommand",
        command: "pyright-langserver",
      },
      {
        type: "nodePackageExec",
        packageName: "pyright",
        binaryName: "pyright-langserver",
      },
    ],
  },
  rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".git"],
  languageIdForPath(): string {
    return "python";
  },
};

const goServer: LspServerDescriptor = {
  id: "go",
  extensions: [".go"],
  launch: {
    type: "provisioned",
    strategies: [
      {
        type: "pathCommand",
        command: "gopls",
      },
      {
        type: "goManagedInstall",
        module: GOPLS_MANAGED_INSTALL_TARGET,
        binaryName: "gopls",
      },
    ],
  },
  rootMarkers: ["go.work", "go.mod", ".git"],
  languageIdForPath(): string {
    return "go";
  },
};

const rustServer: LspServerDescriptor = {
  id: "rust",
  extensions: [".rs"],
  launch: {
    type: "provisioned",
    strategies: [
      {
        type: "pathCommand",
        command: "rust-analyzer",
      },
      {
        type: "unsupported",
        message:
          "rust-analyzer is not available on PATH and automatic installation is not supported yet",
      },
    ],
  },
  rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
  languageIdForPath(): string {
    return "rust";
  },
};

export const BUILTIN_LSP_SERVERS: readonly LspServerDescriptor[] = [
  typescriptServer,
  pythonServer,
  goServer,
  rustServer,
];

export function findLspServerForFile(
  filePath: string,
  registry: readonly LspServerDescriptor[] = BUILTIN_LSP_SERVERS
): LspServerDescriptor | null {
  const fileExt = ext(filePath);
  return registry.find((descriptor) => descriptor.extensions.includes(fileExt)) ?? null;
}
