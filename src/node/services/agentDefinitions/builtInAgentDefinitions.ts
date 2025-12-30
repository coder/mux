import type { AgentDefinitionPackage, AgentId } from "@/common/types/agentDefinition";
import { parseAgentDefinitionMarkdown } from "./parseAgentDefinitionMarkdown";

// Import markdown files as text (bundled at build time via esbuild --loader:.md=text)
import execMd from "@/node/builtinAgents/exec.md";
import planMd from "@/node/builtinAgents/plan.md";
import compactMd from "@/node/builtinAgents/compact.md";
import exploreMd from "@/node/builtinAgents/explore.md";

/**
 * Built-in agent definitions.
 *
 * Source of truth is the markdown files in src/node/builtinAgents/*.md.
 * These are bundled as text at build time and parsed here.
 */

interface BuiltInSource {
  id: AgentId;
  content: string;
}

const BUILT_IN_SOURCES: BuiltInSource[] = [
  { id: "exec", content: execMd },
  { id: "plan", content: planMd },
  { id: "compact", content: compactMd },
  { id: "explore", content: exploreMd },
];

let cachedPackages: AgentDefinitionPackage[] | null = null;

function parseBuiltIns(): AgentDefinitionPackage[] {
  return BUILT_IN_SOURCES.map(({ id, content }) => {
    const parsed = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf8"),
    });
    return {
      id,
      scope: "built-in" as const,
      frontmatter: parsed.frontmatter,
      body: parsed.body.trim(),
    };
  });
}

export function getBuiltInAgentDefinitions(): AgentDefinitionPackage[] {
  cachedPackages ??= parseBuiltIns();
  return cachedPackages;
}

/** Exposed for testing - clears cached parsed packages */
export function clearBuiltInAgentCache(): void {
  cachedPackages = null;
}
