#!/usr/bin/env bun
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as prettier from "prettier";

const ARGS = new Set(process.argv.slice(2));
const MODE = ARGS.has("check") ? "check" : "write";
const PROJECT_ROOT = path.join(import.meta.dir, "..");
const BUILTIN_ACTIONS_DIR = path.join(PROJECT_ROOT, "src", "node", "builtinWorkflowActions");
const OUTPUT_PATH = path.join(
  PROJECT_ROOT,
  "src",
  "node",
  "services",
  "workflows",
  "builtInWorkflowActionContent.generated.ts"
);

interface ActionEntry {
  name: string;
  source: string;
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function listActionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listActionFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.startsWith("_")) {
      files.push(entryPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function readSharedSources(actionPath: string): string[] {
  const sources: string[] = [];
  let current = path.dirname(actionPath);
  while (current.startsWith(BUILTIN_ACTIONS_DIR)) {
    const sharedPath = path.join(current, "_shared.js");
    if (fs.existsSync(sharedPath)) {
      sources.unshift(normalizeNewlines(fs.readFileSync(sharedPath, "utf-8")));
    }
    if (current === BUILTIN_ACTIONS_DIR) break;
    current = path.dirname(current);
  }
  return sources;
}

function actionNameForPath(actionPath: string): string {
  const relative = path.relative(BUILTIN_ACTIONS_DIR, actionPath).replace(/\\/g, "/");
  const name = relative.slice(0, -".js".length).split("/").join(".");
  assert(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/.test(name), `Invalid action name ${name}`);
  return name;
}

function readActionEntry(actionPath: string): ActionEntry {
  const source = [
    ...readSharedSources(actionPath),
    normalizeNewlines(fs.readFileSync(actionPath, "utf-8")),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  assert(source.includes("metadata"), `${actionPath} must export metadata`);
  assert(source.includes("execute"), `${actionPath} must export execute`);
  return { name: actionNameForPath(actionPath), source };
}

function generate(): string {
  const entries = listActionFiles(BUILTIN_ACTIONS_DIR).map(readActionEntry);
  let output = "";
  output += "// AUTO-GENERATED - DO NOT EDIT\n";
  output += "// Run: bun scripts/gen_builtin_workflow_actions.ts\n";
  output += "// Source: src/node/builtinWorkflowActions/**/*.js\n\n";
  output += "export const BUILTIN_WORKFLOW_ACTION_CONTENT: Record<string, string> = {\n";
  for (const entry of entries) {
    output += `  ${JSON.stringify(entry.name)}: ${JSON.stringify(entry.source)},\n`;
  }
  output += "};\n";
  return output;
}

async function main(): Promise<void> {
  const raw = generate();
  const prettierConfig = await prettier.resolveConfig(OUTPUT_PATH);
  const formatted = await prettier.format(raw, { ...prettierConfig, filepath: OUTPUT_PATH });
  const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf-8") : null;
  const outOfSync = current !== formatted;
  if (MODE === "check") {
    if (!outOfSync) {
      console.log(`✓ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is up-to-date`);
      return;
    }
    console.error(`✗ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is out of sync`);
    console.error("  Run 'bun scripts/gen_builtin_workflow_actions.ts' to regenerate.");
    process.exit(1);
  }
  if (outOfSync) {
    fs.writeFileSync(OUTPUT_PATH, formatted, "utf-8");
    console.log(`✓ Updated ${path.relative(PROJECT_ROOT, OUTPUT_PATH)}`);
  } else {
    console.log(`✓ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is up-to-date`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
