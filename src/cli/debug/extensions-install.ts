import { defaultConfig } from "@/node/config";
import {
  installGitExtensionSource,
  type InstallGitExtensionSourceInput,
  type InstallGitExtensionSourceResult,
} from "@/node/extensions/gitExtensionSourceInstaller";

export interface RunDebugExtensionInstallInput {
  coordinate: string;
  muxRootDir?: string;
  write?: (chunk: string) => void;
  install?: (input: InstallGitExtensionSourceInput) => Promise<InstallGitExtensionSourceResult>;
}

export async function debugExtensionInstallCommand(coordinate: string): Promise<void> {
  await runDebugExtensionInstall({ coordinate });
}

export async function runDebugExtensionInstall(
  input: RunDebugExtensionInstallInput
): Promise<InstallGitExtensionSourceResult> {
  const muxRootDir = input.muxRootDir ?? defaultConfig.rootDir;
  const install = input.install ?? installGitExtensionSource;
  const result = await install({ coordinate: input.coordinate, muxRootDir });
  const write = input.write ?? ((chunk: string) => process.stdout.write(chunk));
  write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
