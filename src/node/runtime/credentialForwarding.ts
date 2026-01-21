import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface SshAgentForwarding {
  hostSocketPath: string;
  targetSocketPath: string;
}

export function resolveSshAgentForwarding(targetSocketPath: string): SshAgentForwarding | null {
  const hostSocketPath =
    process.platform === "darwin" ? "/run/host-services/ssh-auth.sock" : process.env.SSH_AUTH_SOCK;

  if (!hostSocketPath || !existsSync(hostSocketPath)) {
    return null;
  }

  return { hostSocketPath, targetSocketPath };
}

export function resolveGhToken(env?: Record<string, string>): string | null {
  return env?.GH_TOKEN ?? process.env.GH_TOKEN ?? null;
}

export function getHostGitconfigPath(): string {
  return path.join(os.homedir(), ".gitconfig");
}

export function hasHostGitconfig(): boolean {
  return existsSync(getHostGitconfigPath());
}

export async function readHostGitconfig(): Promise<Buffer | null> {
  const gitconfigPath = getHostGitconfigPath();
  if (!existsSync(gitconfigPath)) {
    return null;
  }
  return fsPromises.readFile(gitconfigPath);
}
