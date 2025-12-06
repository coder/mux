#!/usr/bin/env bun

// Generates and checks doc snippets so make fmt updates them and make fmt-check flags drift.

import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_MODEL, KNOWN_MODELS } from "../src/common/constants/knownModels";
import { formatModelDisplayName } from "../src/common/utils/ai/modelDisplay";

const MODE: "write" | "check" = process.argv[2] === "check" ? "check" : "write";

async function main() {
  const results = await Promise.all([syncSystemPrompt(), syncKnownModels()]);

  const hasDiff = results.some((r) => r.changed && MODE === "check");
  results.forEach((r) => console.log(r.message));

  if (hasDiff) {
    process.exit(1);
  }
}

async function syncSystemPrompt() {
  const SOURCE_FILE = path.join(process.cwd(), "src/node/services/systemMessage.ts");
  const DOCS_FILE = path.join(process.cwd(), "docs/system-prompt.mdx");
  const BEGIN_MARKER = "{/* BEGIN SYSTEM_PROMPT_DOCS */}";
  const END_MARKER = "{/* END SYSTEM_PROMPT_DOCS */}";

  const source = await fs.readFile(SOURCE_FILE, "utf8");
  const regionMatch = source.match(
    /\/\/ #region SYSTEM_PROMPT_DOCS\r?\n([\s\S]*?)\r?\n\/\/ #endregion SYSTEM_PROMPT_DOCS/
  );
  if (!regionMatch) {
    throw new Error("SYSTEM_PROMPT_DOCS markers not found in src/node/services/systemMessage.ts");
  }
  const region = regionMatch[1].trimEnd();
  const generatedBlock = ["```typescript", region, "```"].join("\n");
  const originalDoc = await fs.readFile(DOCS_FILE, "utf8");
  const updatedDoc = injectBetweenMarkers(
    originalDoc,
    BEGIN_MARKER,
    END_MARKER,
    generatedBlock,
    DOCS_FILE
  );

  if (MODE === "check") {
    const changed = originalDoc !== updatedDoc;
    return {
      changed,
      message: changed
        ? `❌ ${path.relative(process.cwd(), DOCS_FILE)} is out of sync with ${path.relative(process.cwd(), SOURCE_FILE)}`
        : "✅ docs/system-prompt.mdx is in sync",
    };
  }

  if (originalDoc !== updatedDoc) {
    await fs.writeFile(DOCS_FILE, updatedDoc);
    return { changed: true, message: "Updated docs/system-prompt.mdx" };
  }
  return { changed: false, message: "docs/system-prompt.mdx already up to date" };
}

async function syncKnownModels() {
  const DOCS_FILE = path.join(process.cwd(), "docs/models.mdx");
  const BEGIN_MARKER = "{/* BEGIN KNOWN_MODELS_TABLE */}";
  const END_MARKER = "{/* END KNOWN_MODELS_TABLE */}";

  const tableBlock = generateKnownModelsTable();
  const originalDoc = await fs.readFile(DOCS_FILE, "utf8");
  const updatedDoc = injectBetweenMarkers(
    originalDoc,
    BEGIN_MARKER,
    END_MARKER,
    tableBlock,
    DOCS_FILE
  );

  if (MODE === "check") {
    const changed = originalDoc !== updatedDoc;
    return {
      changed,
      message: changed
        ? "❌ docs/models.mdx is out of sync with src/common/constants/knownModels.ts"
        : "✅ docs/models.mdx is in sync with knownModels.ts",
    };
  }

  if (originalDoc !== updatedDoc) {
    await fs.writeFile(DOCS_FILE, updatedDoc);
    return { changed: true, message: "Updated docs/models.mdx" };
  }
  return { changed: false, message: "docs/models.mdx already up to date" };
}

function generateKnownModelsTable(): string {
  // Build row data first to calculate column widths for prettier-compatible output
  const rows = Object.values(KNOWN_MODELS).map((model) => ({
    model: `${formatModelDisplayName(model.providerModelId)} (\`${model.id}\`)`,
    provider: PROVIDER_LABELS[model.provider] ?? model.provider,
    aliases: model.aliases?.length ? model.aliases.map((a) => `\`${a}\``).join(", ") : "—",
    isDefault: model.id === DEFAULT_MODEL ? "Yes" : "—",
  }));

  const headers = ["Model", "Provider", "Aliases", "Default"];
  const colWidths = headers.map((h, i) => {
    const key = ["model", "provider", "aliases", "isDefault"][i] as keyof (typeof rows)[0];
    return Math.max(h.length, ...rows.map((r) => r[key].length));
  });

  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  const headerRow = `| ${headers.map((h, i) => pad(h, colWidths[i])).join(" | ")} |`;
  const sepRow = `| ${colWidths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const dataRows = rows.map(
    (r) =>
      `| ${pad(r.model, colWidths[0])} | ${pad(r.provider, colWidths[1])} | ${pad(r.aliases, colWidths[2])} | ${pad(r.isDefault, colWidths[3])} |`
  );

  return [headerRow, sepRow, ...dataRows].join("\n");
}

const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
} as const;

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
