import * as fs from "fs/promises";
import * as path from "path";

import { ExtensionNameSchema } from "@/common/orpc/schemas/extension";
import { defaultConfig } from "@/node/config";
import {
  installGitExtensionSource,
  type InstallGitExtensionSourceInput,
  type InstallGitExtensionSourceResult,
} from "@/node/extensions/gitExtensionSourceInstaller";

import { getArgsAfterSplice } from "./argv";

export interface CreateLocalExtensionModuleResult {
  extensionName: string;
  modulePath: string;
  entrypointPath: string;
  skillPath: string;
}

export interface InstallHelpResult {
  type: "help";
}

export type RunExtensionsCommandResult =
  | InstallGitExtensionSourceResult
  | CreateLocalExtensionModuleResult
  | InstallHelpResult;

export interface RunExtensionsCommandInput {
  args: readonly string[];
  muxRootDir?: string;
  write?: (chunk: string) => void;
  install?: (input: InstallGitExtensionSourceInput) => Promise<InstallGitExtensionSourceResult>;
}

const EXTENSIONS_HELP = `Usage: mux extensions <install <git-url-or-shorthand>[//subdir]@<ref> | create <extension-name>>
`;
const EXTENSIONS_INSTALL_HELP = `Usage: mux extensions install <git-url-or-shorthand>[//subdir]@<ref>
`;
const EXTENSIONS_CREATE_HELP = `Usage: mux extensions create <extension-name>
`;

function isHelpArg(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

export async function runExtensionsCommand(
  input: RunExtensionsCommandInput
): Promise<RunExtensionsCommandResult> {
  const [command, value] = input.args;
  const muxRootDir = input.muxRootDir ?? defaultConfig.rootDir;
  const write = input.write ?? ((chunk: string) => process.stdout.write(chunk));

  if (isHelpArg(command)) {
    write(EXTENSIONS_HELP);
    return { type: "help" };
  }

  if (command === "install") {
    if (isHelpArg(value)) {
      write(EXTENSIONS_INSTALL_HELP);
      return { type: "help" };
    }
    if (value == null || value.trim() === "") {
      throw new Error("Git extension coordinate required.");
    }
    const install = input.install ?? installGitExtensionSource;
    const result = await install({ coordinate: value, muxRootDir });
    write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  if (command === "create") {
    if (isHelpArg(value)) {
      write(EXTENSIONS_CREATE_HELP);
      return { type: "help" };
    }
    if (value == null || value.trim() === "") {
      throw new Error("Extension Name required.");
    }
    const result = await createLocalExtensionModule({ extensionName: value, muxRootDir });
    write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  throw new Error(
    "Usage: mux extensions <install <git-url-or-shorthand>[//subdir]@<ref> | create <extension-name>>"
  );
}

async function createLocalExtensionModule(input: {
  extensionName: string;
  muxRootDir: string;
}): Promise<CreateLocalExtensionModuleResult> {
  const parsedName = ExtensionNameSchema.safeParse(input.extensionName);
  if (!parsedName.success) {
    throw new Error(`Invalid Extension Name: ${parsedName.error.message}`);
  }

  const extensionName = parsedName.data;
  const localRoot = path.join(input.muxRootDir, "extensions", "local");
  const modulePath = path.join(localRoot, extensionName);
  const skillDir = path.join(modulePath, "skills", extensionName);
  const entrypointPath = path.join(modulePath, "extension.ts");
  const skillPath = path.join(skillDir, "SKILL.md");

  await fs.mkdir(localRoot, { recursive: true });
  await fs.mkdir(modulePath);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(entrypointPath, extensionEntrypointTemplate(extensionName), { flag: "wx" });
  await fs.writeFile(skillPath, skillTemplate(extensionName), { flag: "wx" });

  return { extensionName, modulePath, entrypointPath, skillPath };
}

function extensionEntrypointTemplate(extensionName: string): string {
  return `import { defineManifest } from "mux:extensions";

export const manifest = defineManifest({
  name: "${extensionName}",
  displayName: "${extensionName}",
  description: "Describe what this extension contributes.",
  capabilities: {
    skills: true,
  },
});

export function activate(ctx) {
  ctx.skills.register({
    name: "${extensionName}",
    bodyPath: "./skills/${extensionName}/SKILL.md",
  });
}
`;
}

function skillTemplate(extensionName: string): string {
  return `---
name: ${extensionName}
description: Describe when to use this extension skill.
---

# ${extensionName}

Write instructions for the agent here.
`;
}

const INSTALL_ALIAS_HELP = `Usage: mux install <git-url-or-shorthand>[//subdir]@<ref>

Alias for: mux extensions install <git-url-or-shorthand>[//subdir]@<ref>
`;

export async function runInstallAliasCommand(
  input: RunExtensionsCommandInput
): Promise<RunExtensionsCommandResult> {
  const [firstArg] = input.args;
  if (isHelpArg(firstArg)) {
    const write = input.write ?? ((chunk: string) => process.stdout.write(chunk));
    write(INSTALL_ALIAS_HELP);
    return { type: "help" };
  }
  return runExtensionsCommand({
    ...input,
    args: ["install", ...input.args],
  });
}

export async function installAliasCommandMain(): Promise<void> {
  try {
    await runInstallAliasCommand({ args: getArgsAfterSplice() });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function extensionsCommandMain(): Promise<void> {
  try {
    await runExtensionsCommand({ args: getArgsAfterSplice() });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
