#!/usr/bin/env bun
/**
 * Generate documentation snippets from source files.
 *
 * Usage:
 *   bun scripts/gen_docs.ts         # write mode (update docs)
 *   bun scripts/gen_docs.ts check   # check mode (verify docs are up-to-date)
 *
 * This script synchronizes:
 *   - docs/system-prompt.mdx: snippet from src/node/services/systemMessage.ts
 *   - docs/models.mdx: table from src/common/constants/knownModels.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { KNOWN_MODELS, DEFAULT_MODEL } from "../src/common/constants/knownModels";
import { formatModelDisplayName } from "../src/common/utils/ai/modelDisplay";
import { ModeFrontmatterSchema, type ModeFrontmatter } from "../src/common/types/mode";

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
  const newContent = injectBetweenMarkers(currentContent, markerName, block);

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
    docsFile: "system-prompt.mdx",
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
    docsFile: "models.mdx",
    sourceLabel: "src/common/constants/knownModels.ts",
    markerName: "KNOWN_MODELS_TABLE",
    generateBlock: generateKnownModelsTable,
  });
}

// ---------------------------------------------------------------------------
// Built-in modes sync
// ---------------------------------------------------------------------------

interface ParsedMode {
  frontmatter: ModeFrontmatter;
  instructions: string;
  filename: string;
}

function parseModeFrontmatter(content: string): { frontmatter: unknown; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  return {
    frontmatter: yaml.parse(match[1]),
    body: match[2].trim(),
  };
}

function loadBuiltinModes(): ParsedMode[] {
  const modesDir = path.join(import.meta.dir, "..", "src", "node", "builtinModes");
  const files = fs.readdirSync(modesDir).filter((f) => f.endsWith(".md"));

  const modes: ParsedMode[] = [];
  for (const filename of files) {
    const content = fs.readFileSync(path.join(modesDir, filename), "utf-8");
    const parsed = parseModeFrontmatter(content);
    if (!parsed) {
      throw new Error(`Failed to parse frontmatter in ${filename}`);
    }

    const result = ModeFrontmatterSchema.safeParse(parsed.frontmatter);
    if (!result.success) {
      throw new Error(`Invalid frontmatter in ${filename}: ${result.error.message}`);
    }

    modes.push({
      frontmatter: result.data,
      instructions: parsed.body,
      filename,
    });
  }

  // Sort by name for consistent output
  return modes.sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
}

function generateBuiltinModesBlock(): string {
  const modes = loadBuiltinModes();
  const sections: string[] = [];

  for (const mode of modes) {
    const { frontmatter, instructions, filename } = mode;
    const lines: string[] = [];

    // Header with icon
    const icon = frontmatter.icon ? `${frontmatter.icon} ` : "";
    lines.push(`### ${icon}${frontmatter.label}`);
    lines.push("");
    lines.push(`**${frontmatter.description}**`);
    lines.push("");

    // Show the full mode file as an example
    lines.push(`<Accordion title="View ${filename}">`);
    lines.push("");
    lines.push("```markdown");

    // Reconstruct the file content
    const yamlContent = yaml.stringify(frontmatter, { lineWidth: 0 }).trim();
    lines.push("---");
    lines.push(yamlContent);
    lines.push("---");
    if (instructions) {
      lines.push("");
      // Normalize blank lines (collapse multiple to single) for Prettier compatibility
      const normalizedInstructions = instructions.replace(/\n\n+/g, "\n\n").trim();
      lines.push(normalizedInstructions);
    }
    lines.push("```");
    lines.push("");
    lines.push("</Accordion>");

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

async function syncBuiltinModes(): Promise<boolean> {
  return syncDoc({
    docsFile: "modes.mdx",
    sourceLabel: "src/node/builtinModes/*.md",
    markerName: "BUILTIN_MODES",
    generateBlock: generateBuiltinModesBlock,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const results = await Promise.all([syncSystemPrompt(), syncKnownModels(), syncBuiltinModes()]);

  if (results.some((r) => !r)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
