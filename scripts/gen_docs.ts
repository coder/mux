#!/usr/bin/env bun
/**
 * Generate documentation snippets from source files.
 *
 * Usage:
 *   bun scripts/gen_docs.ts         # write mode (update docs)
 *   bun scripts/gen_docs.ts check   # check mode (verify docs are up-to-date)
 *
 * This script synchronizes:
 *   - docs/agents/system-prompt.mdx: snippet from src/node/services/systemMessage.ts
 *   - docs/config/models.mdx: table from src/common/constants/knownModels.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import * as prettier from "prettier";
import { KNOWN_MODELS, DEFAULT_MODEL } from "../src/common/constants/knownModels";
import { formatModelDisplayName } from "../src/common/utils/ai/modelDisplay";
import { AgentDefinitionFrontmatterSchema } from "../src/common/orpc/schemas/agentDefinition";

const MODE = process.argv[2] === "check" ? "check" : "write";
const DOCS_DIR = path.join(import.meta.dir, "..", "docs");

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

function injectBetweenMarkers(content: string, markerName: string, block: string): string {
  const beginMarker = `{/* BEGIN ${markerName} */}`;
  const endMarker = `{/* END ${markerName} */}`;

  const beginIdx = content.indexOf(beginMarker);
  const endIdx = content.indexOf(endMarker);

  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(`Missing markers for ${markerName}`);
  }

  const before = content.slice(0, beginIdx + beginMarker.length);
  const after = content.slice(endIdx);

  return `${before}\n\n${block}\n\n${after}`;
}

// ---------------------------------------------------------------------------
// Generic sync helper
// ---------------------------------------------------------------------------

interface SyncDocOptions {
  docsFile: string;
  sourceLabel: string;
  markerName: string;
  generateBlock: () => string;
}

async function syncDoc(options: SyncDocOptions): Promise<boolean> {
  const { docsFile, sourceLabel, markerName, generateBlock } = options;
  const docsPath = path.join(DOCS_DIR, docsFile);

  const currentContent = fs.readFileSync(docsPath, "utf-8");
  const block = generateBlock();
  const rawContent = injectBetweenMarkers(currentContent, markerName, block);

  // Format with prettier to ensure consistent output
  const prettierConfig = await prettier.resolveConfig(docsPath);
  const newContent = await prettier.format(rawContent, {
    ...prettierConfig,
    filepath: docsPath,
  });

  if (currentContent === newContent) {
    console.log(`✓ ${docsFile} is up-to-date with ${sourceLabel}`);
    return true;
  }

  if (MODE === "check") {
    console.error(`✗ ${docsFile} is out of sync with ${sourceLabel}`);
    console.error(`  Run 'make fmt' to regenerate.`);
    return false;
  }

  fs.writeFileSync(docsPath, newContent, "utf-8");
  console.log(`✓ Updated ${docsFile} from ${sourceLabel}`);
  return true;
}

// ---------------------------------------------------------------------------
// System prompt sync
// ---------------------------------------------------------------------------

function generateSystemPromptBlock(): string {
  const systemMessagePath = path.join(
    import.meta.dir,
    "..",
    "src",
    "node",
    "services",
    "systemMessage.ts"
  );
  const source = fs.readFileSync(systemMessagePath, "utf-8");

  const regionStart = "// #region SYSTEM_PROMPT_DOCS";
  const regionEnd = "// #endregion SYSTEM_PROMPT_DOCS";

  const startIdx = source.indexOf(regionStart);
  const endIdx = source.indexOf(regionEnd);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error("Could not find SYSTEM_PROMPT_DOCS region in systemMessage.ts");
  }

  const snippet = source.slice(startIdx + regionStart.length, endIdx).trim();
  return "```typescript\n" + snippet + "\n```";
}

async function syncSystemPrompt(): Promise<boolean> {
  return syncDoc({
    docsFile: "agents/system-prompt.mdx",
    sourceLabel: "src/node/services/systemMessage.ts",
    markerName: "SYSTEM_PROMPT_DOCS",
    generateBlock: generateSystemPromptBlock,
  });
}

// ---------------------------------------------------------------------------
// Known models table sync
// ---------------------------------------------------------------------------

function generateKnownModelsTable(): string {
  const rows: Array<{ name: string; id: string; aliases: string; isDefault: boolean }> = [];

  for (const model of Object.values(KNOWN_MODELS)) {
    rows.push({
      name: formatModelDisplayName(model.providerModelId),
      id: model.id,
      aliases: (model.aliases ?? []).map((a) => `\`${a}\``).join(", ") || "—",
      isDefault: model.id === DEFAULT_MODEL,
    });
  }

  // Calculate column widths
  const headers = ["Model", "ID", "Aliases", "Default"];
  const widths = headers.map((h, i) => {
    const colValues = rows.map((r) => {
      if (i === 0) return r.name;
      if (i === 1) return r.id;
      if (i === 2) return r.aliases;
      return r.isDefault ? "✓" : "";
    });
    return Math.max(h.length, ...colValues.map((v) => v.length));
  });

  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);

  const headerRow = `| ${headers.map((h, i) => pad(h, widths[i])).join(" | ")} |`;
  const sepRow = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const dataRows = rows.map((r) => {
    const cells = [
      pad(r.name, widths[0]),
      pad(r.id, widths[1]),
      pad(r.aliases, widths[2]),
      pad(r.isDefault ? "✓" : "", widths[3]),
    ];
    return `| ${cells.join(" | ")} |`;
  });

  return [headerRow, sepRow, ...dataRows].join("\n");
}

async function syncKnownModels(): Promise<boolean> {
  return syncDoc({
    docsFile: "config/models.mdx",
    sourceLabel: "src/common/constants/knownModels.ts",
    markerName: "KNOWN_MODELS_TABLE",
    generateBlock: generateKnownModelsTable,
  });
}

// ---------------------------------------------------------------------------
// Built-in agents sync
// ---------------------------------------------------------------------------

interface ParsedAgent {
  id: string;
  frontmatter: ReturnType<typeof AgentDefinitionFrontmatterSchema.parse>;
  body: string;
  /** Original file content (preserves comments and formatting) */
  rawContent: string;
}

function parseFrontmatter(content: string): { frontmatter: unknown; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  return {
    frontmatter: yaml.parse(match[1]),
    body: match[2].trim(),
  };
}

function loadBuiltinAgents(): ParsedAgent[] {
  const agentsDir = path.join(import.meta.dir, "..", "src", "node", "builtinAgents");
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

  const agents: ParsedAgent[] = [];
  for (const filename of files) {
    const content = fs.readFileSync(path.join(agentsDir, filename), "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      throw new Error(`Failed to parse frontmatter in ${filename}`);
    }

    const result = AgentDefinitionFrontmatterSchema.safeParse(parsed.frontmatter);
    if (!result.success) {
      throw new Error(`Invalid frontmatter in ${filename}: ${result.error.message}`);
    }

    agents.push({
      id: filename.slice(0, -3), // Remove .md extension
      frontmatter: result.data,
      body: parsed.body,
      rawContent: content.trim(),
    });
  }

  // Sort: visible agents first (exec, plan), then hidden ones
  return agents.sort((a, b) => {
    const aHidden = a.frontmatter.ui?.hidden ?? false;
    const bHidden = b.frontmatter.ui?.hidden ?? false;
    if (aHidden !== bHidden) return aHidden ? 1 : -1;
    return a.frontmatter.name.localeCompare(b.frontmatter.name);
  });
}

function generateBuiltinAgentsBlock(): string {
  const agents = loadBuiltinAgents();
  const sections: string[] = [];

  for (const agent of agents) {
    const { id, frontmatter, rawContent } = agent;
    const lines: string[] = [];

    // Header
    const hiddenBadge = frontmatter.ui?.hidden ? " (internal)" : "";
    lines.push(`### ${frontmatter.name}${hiddenBadge}`);
    lines.push("");
    if (frontmatter.description) {
      lines.push(`**${frontmatter.description}**`);
      lines.push("");
    }

    // Show the full agent file as an example (using raw content to preserve comments)
    lines.push(`<Accordion title="View ${id}.md">`);
    lines.push("");
    lines.push("```md");
    lines.push(rawContent);
    lines.push("```");
    lines.push("");
    lines.push("</Accordion>");

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

async function syncBuiltinAgents(): Promise<boolean> {
  return syncDoc({
    docsFile: "agents/index.mdx",
    sourceLabel: "src/node/builtinAgents/*.md",
    markerName: "BUILTIN_AGENTS",
    generateBlock: generateBuiltinAgentsBlock,
  });
}

// ---------------------------------------------------------------------------
// User notify tool docs sync
// ---------------------------------------------------------------------------

function generateUserNotifyBlock(): string {
  const toolDefsPath = path.join(
    import.meta.dir,
    "..",
    "src",
    "common",
    "utils",
    "tools",
    "toolDefinitions.ts"
  );
  const source = fs.readFileSync(toolDefsPath, "utf-8");

  const regionStart = "// #region USER_NOTIFY_DOCS";
  const regionEnd = "// #endregion USER_NOTIFY_DOCS";

  const startIdx = source.indexOf(regionStart);
  const endIdx = source.indexOf(regionEnd);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error("Could not find USER_NOTIFY_DOCS region in toolDefinitions.ts");
  }

  const snippet = source.slice(startIdx + regionStart.length, endIdx).trim();
  return "```typescript\n" + snippet + "\n```";
}

async function syncUserNotifyDocs(): Promise<boolean> {
  return syncDoc({
    docsFile: "config/notifications.mdx",
    sourceLabel: "src/common/utils/tools/toolDefinitions.ts",
    markerName: "USER_NOTIFY_TOOL",
    generateBlock: generateUserNotifyBlock,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const results = await Promise.all([
    syncSystemPrompt(),
    syncKnownModels(),
    syncBuiltinAgents(),
    syncUserNotifyDocs(),
  ]);

  if (results.some((r) => !r)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
