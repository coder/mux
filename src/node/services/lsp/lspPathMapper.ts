import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import type { Runtime } from "@/node/runtime/Runtime";

interface LspPathMapperOptions {
  runtime: Runtime;
  workspacePath: string;
}

type PathModule = typeof path.posix;

function selectPathModule(filePath: string): PathModule {
  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.includes("\\")) {
    return path.win32;
  }
  return path.posix;
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const pathModule = selectPathModule(targetPath);
  const relativePath = pathModule.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !pathModule.isAbsolute(relativePath));
}

function fileUriToPath(uri: string): string {
  const parsed = new URL(uri);
  const decodedPath = decodeURIComponent(parsed.pathname);
  if (/^\/[A-Za-z]:\//.test(decodedPath)) {
    return decodedPath.slice(1);
  }
  return decodedPath;
}

export class LspPathMapper {
  constructor(private readonly options: LspPathMapperOptions) {}

  getWorkspaceRuntimePath(): string {
    if (this.options.runtime instanceof DevcontainerRuntime) {
      const remoteWorkspaceFolder = this.options.runtime.getRemoteWorkspaceFolder();
      if (!remoteWorkspaceFolder) {
        throw new Error("Devcontainer runtime is missing its remote workspace folder");
      }
      return remoteWorkspaceFolder;
    }

    return this.options.workspacePath;
  }

  resolveToolPath(filePath: string): string {
    return this.options.runtime.normalizePath(filePath, this.options.workspacePath);
  }

  toRuntimePath(filePath: string): string {
    const toolPath = this.resolveToolPath(filePath);

    if (!(this.options.runtime instanceof DevcontainerRuntime)) {
      return toolPath;
    }

    const remoteWorkspaceFolder = this.options.runtime.getRemoteWorkspaceFolder();
    if (!remoteWorkspaceFolder) {
      throw new Error("Devcontainer runtime is missing its remote workspace folder");
    }

    if (toolPath === remoteWorkspaceFolder || toolPath.startsWith(`${remoteWorkspaceFolder}/`)) {
      return toolPath;
    }

    if (!isPathInside(this.options.workspacePath, toolPath)) {
      throw new Error(
        `LSP paths must stay inside the workspace for devcontainer runtimes (got ${toolPath})`
      );
    }

    const relativePath = path.relative(this.options.workspacePath, toolPath);
    return relativePath.length === 0
      ? remoteWorkspaceFolder
      : path.posix.join(remoteWorkspaceFolder, relativePath.split(path.sep).join("/"));
  }

  toOutputPath(runtimePath: string): string {
    if (!(this.options.runtime instanceof DevcontainerRuntime)) {
      return runtimePath;
    }

    const remoteWorkspaceFolder = this.options.runtime.getRemoteWorkspaceFolder();
    if (!remoteWorkspaceFolder) {
      return runtimePath;
    }

    if (runtimePath === remoteWorkspaceFolder || runtimePath.startsWith(`${remoteWorkspaceFolder}/`)) {
      const relativePath = runtimePath.slice(remoteWorkspaceFolder.length).replace(/^\/+/, "");
      return relativePath.length === 0
        ? this.options.workspacePath
        : path.join(this.options.workspacePath, relativePath);
    }

    return runtimePath;
  }

  toReadablePath(runtimePath: string): string {
    return this.toOutputPath(runtimePath);
  }

  toUri(runtimePath: string): string {
    return pathToFileURL(runtimePath).href;
  }

  fromUri(uri: string): string {
    return fileUriToPath(uri);
  }

  isWithinWorkspace(runtimePath: string): boolean {
    return isPathInside(this.getWorkspaceRuntimePath(), runtimePath);
  }
}
