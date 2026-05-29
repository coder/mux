import * as fs from "fs/promises";
import * as path from "path";
import type { DevcontainerConfigInfo } from "@/common/types/runtime";

export function formatDevcontainerLabel(configPath: string): string {
  if (configPath === ".devcontainer.json") {
    return "Default (.devcontainer.json)";
  }

  if (configPath === ".devcontainer/devcontainer.json") {
    return "Default (.devcontainer/devcontainer.json)";
  }

  const normalized = configPath.replace(/\\/g, "/");
  const match = /^\.devcontainer\/([^/]+)\/devcontainer\.json$/.exec(normalized);
  if (match?.[1]) {
    return `${match[1]} (${normalized})`;
  }

  return normalized;
}

export function buildDevcontainerConfigInfo(configs: string[]): DevcontainerConfigInfo[] {
  return configs.map((configPath) => ({
    path: configPath,
    label: formatDevcontainerLabel(configPath),
  }));
}

/**
 * Scan for devcontainer.json files in a project.
 * Returns paths relative to project root.
 */
export async function scanDevcontainerConfigs(projectPath: string): Promise<string[]> {
  const configs: string[] = [];

  // Check standard locations
  const locations = [".devcontainer.json", ".devcontainer/devcontainer.json"];

  for (const loc of locations) {
    try {
      await fs.access(path.join(projectPath, loc));
      configs.push(loc);
    } catch {
      // File doesn't exist
    }
  }

  // Also scan .devcontainer/*/devcontainer.json for multi-config projects
  try {
    const devcontainerDir = path.join(projectPath, ".devcontainer");
    const entries = await fs.readdir(devcontainerDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const configPath = path.join(".devcontainer", entry.name, "devcontainer.json");
        try {
          await fs.access(path.join(projectPath, configPath));
          configs.push(configPath);
        } catch {
          // File doesn't exist
        }
      }
    }
  } catch {
    // .devcontainer directory doesn't exist
  }

  return configs;
}
