#!/usr/bin/env bun

// Generates and checks doc snippets so make fmt updates them and make fmt-check flags drift.

import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_MODEL, KNOWN_MODELS } from "../src/common/constants/knownModels";
import { formatModelDisplayName } from "../src/common/utils/ai/modelDisplay";

const MODE: "write" | "check" = process.argv[2] === "check" ? "check" : "write";

interface SyncResult {
  changed: boolean;
  message: string;
}

interface SyncConfig {
  docsFile: string;
  sourceLabel: string;
  markerName: string;
  generateBlock: () => Promise<string> | string;
}

async function syncDoc(config: SyncConfig): Promise<SyncResult> {
  const beginMarker = `{/* BEGIN ${config.markerName} */}`;
  const endMarker = `{/* END ${config.markerName} */}`;
  const docsPath = path.join(process.cwd(), config.docsFile);
  const relPath = path.relative(process.cwd(), docsPath);

  const block = await config.generateBlock();
  const original = await fs.readFile(docsPath, "utf8");
  const updated = injectBetweenMarkers(original, beginMarker, endMarker, block, docsPath);
  const changed = original !== updated;

  if (MODE === "check") {
    return {
      changed,
      message: changed
        ? `❌ ${relPath} is out of sync with ${config.sourceLabel}`
        : `✅ ${relPath} is in sync`,
    };
  }

  if (changed) {
    await fs.writeFile(docsPath, updated);
    return { changed: true, message: `Updated ${relPath}` };
  }
  return { changed: false, message: `${relPath} already up to date` };
}

async function main() {
  const results = await Promise.all([
    syncDoc({
      docsFile: "docs/system-prompt.mdx",
      sourceLabel: "src/node/services/systemMessage.ts",
      markerName: "SYSTEM_PROMPT_DOCS",
      generateBlock: generateSystemPromptBlock,
    }),
    syncDoc({
      docsFile: "docs/models.mdx",
      sourceLabel: "src/common/constants/knownModels.ts",
      markerName: "KNOWN_MODELS_TABLE",
      generateBlock: generateKnownModelsTable,
    }),
  ]);

  results.forEach((r) => console.log(r.message));
  if (MODE === "check" && results.some((r) => r.changed)) {
    process.exit(1);
  }
}

async function generateSystemPromptBlock(): Promise<string> {
  const sourcePath = path.join(process.cwd(), "src/node/services/systemMessage.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const regionMatch = source.match(
    /\/\/ #region SYSTEM_PROMPT_DOCS\r?\n([\s\S]*?)\r?\n\/\/ #endregion SYSTEM_PROMPT_DOCS/
  );
  if (!regionMatch) {
    throw new Error("SYSTEM_PROMPT_DOCS markers not found in src/node/services/systemMessage.ts");
  }
  return ["```typescript", regionMatch[1].trimEnd(), "```"].join("\n");
}

function generateKnownModelsTable(): string {
  const rows = Object.values(KNOWN_MODELS).map((model) => ({
    name: formatModelDisplayName(model.providerModelId),
    id: `\`${model.id}\``,
    aliases: model.aliases?.length ? model.aliases.map((a) => `\`${a}\``).join(", ") : "—",
    isDefault: model.id === DEFAULT_MODEL ? "Yes" : "—",
  }));

  const headers = ["Model", "ID", "Aliases", "Default"];
  const keys: (keyof (typeof rows)[0])[] = ["name", "id", "aliases", "isDefault"];
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[keys[i]].length)));

  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  const headerRow = `| ${headers.map((h, i) => pad(h, colWidths[i])).join(" | ")} |`;
  const sepRow = `| ${colWidths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const dataRows = rows.map((r) => `| ${keys.map((k, i) => pad(r[k], colWidths[i])).join(" | ")} |`);

  return [headerRow, sepRow, ...dataRows].join("\n");
}

function injectBetweenMarkers(
  doc: string,
  begin: string,
  end: string,
  block: string,
  filePath: string
): string {
  const start = doc.indexOf(begin);
  const finish = doc.indexOf(end);

  if (start === -1 || finish === -1) {
    throw new Error(`Markers ${begin} and ${end} must exist in ${filePath}`);
  }
  if (finish <= start) {
    throw new Error(`END marker must appear after BEGIN marker in ${filePath}`);
  }

  const before = doc.slice(0, start + begin.length);
  const after = doc.slice(finish);

  return `${before}\n\n${block}\n\n${after}`;
}

await main();
