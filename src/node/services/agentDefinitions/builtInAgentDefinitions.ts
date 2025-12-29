import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AgentDefinitionPackage } from "@/common/types/agentDefinition";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { parseAgentDefinitionMarkdown } from "./parseAgentDefinitionMarkdown";

/**
 * Built-in agents directory path.
 * In development: src/node/builtinAgents/ (relative to src/node/services/agentDefinitions/)
 * In production:  dist/builtinAgents/     (relative to dist/services/agentDefinitions/)
 * Both resolve correctly via __dirname + ../../builtinAgents
 */
const BUILTIN_AGENTS_DIR = path.join(__dirname, "../../builtinAgents");

let cachedPackages: AgentDefinitionPackage[] | null = null;
let loadPromise: Promise<AgentDefinitionPackage[]> | null = null;

async function loadBuiltInAgentsFromDisk(): Promise<AgentDefinitionPackage[]> {
  const packages: AgentDefinitionPackage[] = [];

  let filenames: string[];
  try {
    filenames = await fs.readdir(BUILTIN_AGENTS_DIR);
  } catch {
    // Directory doesn't exist (shouldn't happen in production)
    return [];
  }

  for (const filename of filenames) {
    if (!filename.endsWith(".md")) continue;

    const agentId = filename.slice(0, -3).toLowerCase();
    const idResult = AgentIdSchema.safeParse(agentId);
    if (!idResult.success) continue;

    const filePath = path.join(BUILTIN_AGENTS_DIR, filename);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    try {
      const parsed = parseAgentDefinitionMarkdown({
        content,
        byteSize: Buffer.byteLength(content),
      });
      packages.push({
        id: idResult.data,
        scope: "built-in",
        frontmatter: parsed.frontmatter,
        body: parsed.body,
      });
    } catch {
      // Skip invalid files
      continue;
    }
  }

  return packages;
}

export async function getBuiltInAgentDefinitions(): Promise<AgentDefinitionPackage[]> {
  if (cachedPackages) {
    return cachedPackages;
  }

  // Avoid duplicate loading if called concurrently
  loadPromise ??= loadBuiltInAgentsFromDisk().then((packages) => {
    cachedPackages = packages;
    loadPromise = null;
    return packages;
  });

  return loadPromise;
}

/** Exposed for testing - clears the cache so files are re-read */
export function clearBuiltInAgentCache(): void {
  cachedPackages = null;
  loadPromise = null;
}
