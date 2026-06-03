#!/usr/bin/env bun
import assert from "node:assert/strict";
/**
 * Generate built-in workflow content.
 *
 * Usage:
 *   bun scripts/gen_builtin_workflows.ts         # write mode
 *   bun scripts/gen_builtin_workflows.ts check   # check mode
 *
 * Built-in workflow definitions are authored as real JavaScript files in
 * src/node/builtinWorkflows/ (so they get syntax highlighting, formatting, and
 * direct unit tests) and embedded as strings for the QuickJS workflow sandbox.
 *
 * This script writes:
 *   - src/node/services/workflows/builtInWorkflowContent.generated.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as prettier from "prettier";
import { WorkflowNameSchema } from "../src/common/orpc/schemas/workflow";
// Shared with the runtime workflow scanner so the `// description:` convention
// cannot drift between codegen and WorkflowDefinitionStore. workflowDescription
// is dependency-free, so importing it here cannot recurse into the generated
// module this script produces.
import { parseWorkflowDescription } from "../src/node/services/workflows/workflowDescription";

const ARGS = new Set(process.argv.slice(2));
const MODE = ARGS.has("check") ? "check" : "write";

const PROJECT_ROOT = path.join(import.meta.dir, "..");
const BUILTIN_WORKFLOWS_DIR = path.join(PROJECT_ROOT, "src", "node", "builtinWorkflows");
const OUTPUT_PATH = path.join(
  PROJECT_ROOT,
  "src",
  "node",
  "services",
  "workflows",
  "builtInWorkflowContent.generated.ts"
);

// Keep in sync with compileWorkflowSource in src/node/services/workflows/WorkflowRunner.ts.
// The runtime strip is a lexical transform, so a template-literal line that
// happens to start with `export const ...` would be silently corrupted before
// reaching the model. assertNoTemplateLiteralExportLines guards built-ins
// against that at generation time.
const NAMED_EXPORT_STRIP_PATTERN =
  /^export\s+(?=(?:async\s+)?function\s|class\s|const\s|let\s|var\s)/gmu;

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function assertNoTemplateLiteralExportLines(filename: string, source: string): void {
  const strippableLines = source.match(NAMED_EXPORT_STRIP_PATTERN)?.length ?? 0;
  // Bun's transpiler is a real parser, so template-literal contents never count
  // as exports. Every regex-strippable line declares at least one named export,
  // so more strippable lines than parsed named exports means at least one match
  // sits inside a template literal (or other non-declaration position).
  const parsedNamedExports = new Bun.Transpiler({ loader: "js" })
    .scan(source)
    .exports.filter((name) => name !== "default").length;
  assert(
    strippableLines <= parsedNamedExports,
    `Built-in workflow ${filename} has ${strippableLines} flush-left 'export <declaration>' lines ` +
      `but only ${parsedNamedExports} parsed named exports. A template literal likely contains a ` +
      `flush-left 'export ' line, which compileWorkflowSource would silently corrupt. Indent it.`
  );
}

interface BuiltInWorkflowEntry {
  name: string;
  description: string;
  source: string;
}

function readWorkflowEntry(filename: string): BuiltInWorkflowEntry {
  const name = filename.slice(0, -".js".length);
  const parsedName = WorkflowNameSchema.safeParse(name);
  assert(
    parsedName.success,
    `Built-in workflow filename must be a valid workflow name: ${filename}`
  );

  const source = normalizeNewlines(
    fs.readFileSync(path.join(BUILTIN_WORKFLOWS_DIR, filename), "utf-8")
  );

  const description = parseWorkflowDescription(source);
  assert(
    description,
    `Built-in workflow ${filename} must start with a '// description: ...' header line`
  );

  // Sanity check only; WorkflowRunner's compileWorkflowSource performs the
  // authoritative rewrite when the workflow runs.
  assert(
    /^export default (?:async )?function/m.test(source),
    `Built-in workflow ${filename} must export a default function`
  );
  assertNoTemplateLiteralExportLines(filename, source);

  return { name, description, source };
}

function generate(): string {
  const filenames = fs
    .readdirSync(BUILTIN_WORKFLOWS_DIR)
    .filter((entry) => entry.endsWith(".js"))
    .sort((a, b) => a.localeCompare(b));
  assert(filenames.length > 0, `No built-in workflow sources found in ${BUILTIN_WORKFLOWS_DIR}`);

  const entries = filenames.map(readWorkflowEntry);

  let output = "";
  output += "// AUTO-GENERATED - DO NOT EDIT\n";
  output += "// Run: bun scripts/gen_builtin_workflows.ts\n";
  output += "// Source: src/node/builtinWorkflows/*.js\n\n";
  output += "export interface BuiltInWorkflowContentEntry {\n";
  output += "  readonly name: string;\n";
  output += "  readonly description: string;\n";
  output += "  readonly source: string;\n";
  output += "}\n\n";
  output += "export const BUILTIN_WORKFLOW_CONTENT: readonly BuiltInWorkflowContentEntry[] = [\n";
  for (const entry of entries) {
    output += "  {\n";
    output += `    name: ${JSON.stringify(entry.name)},\n`;
    output += `    description: ${JSON.stringify(entry.description)},\n`;
    output += `    source: ${JSON.stringify(entry.source)},\n`;
    output += "  },\n";
  }
  output += "];\n";

  return output;
}

async function main(): Promise<void> {
  const raw = generate();

  const prettierConfig = await prettier.resolveConfig(OUTPUT_PATH);
  const formatted = await prettier.format(raw, {
    ...prettierConfig,
    filepath: OUTPUT_PATH,
  });

  const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf-8") : null;
  const outOfSync = current !== formatted;

  if (MODE === "check") {
    if (!outOfSync) {
      console.log(`✓ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is up-to-date`);
      return;
    }
    console.error(`✗ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is out of sync`);
    console.error("  Run 'bun scripts/gen_builtin_workflows.ts' to regenerate.");
    process.exit(1);
  }

  if (outOfSync) {
    fs.writeFileSync(OUTPUT_PATH, formatted, "utf-8");
    console.log(`✓ Updated ${path.relative(PROJECT_ROOT, OUTPUT_PATH)}`);
  } else {
    console.log(`✓ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is up-to-date`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
