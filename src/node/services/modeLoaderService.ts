import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Config } from "@/node/config";
import type { Runtime } from "@/node/runtime/Runtime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";
import { log } from "@/node/services/log";
import { validateFileSize } from "@/node/services/tools/fileCommon";
import YAML from "yaml";

import {
  ModeFrontmatterSchema,
  ModeDefinitionSchema,
  type ModeDefinition,
  type ModeFrontmatter,
  type ModeSource,
} from "@/common/types/mode";

const GLOBAL_MODES_DIR = "modes";
const PROJECT_MODES_DIR = ".mux/modes";
const MODE_FILE_EXTENSION = ".md";

export class ModeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeParseError";
  }
}

interface ParsedModeMarkdown {
  frontmatter: ModeFrontmatter;
  body: string;
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripUtf8Bom(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

function formatZodIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>
): string {
  return issues
    .map((issue) => {
      const issuePath =
        issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Parse a mode markdown file into validated frontmatter + markdown body.
 */
function parseModeMarkdown(content: string, filePath: string): ParsedModeMarkdown {
  const normalized = normalizeNewlines(stripUtf8Bom(content));

  if (!normalized.startsWith("---")) {
    throw new ModeParseError(`Mode file must start with YAML frontmatter: ${filePath}`);
  }

  const lines = normalized.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    throw new ModeParseError(
      `Mode file frontmatter start delimiter must be exactly '---': ${filePath}`
    );
  }

  const endIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
  if (endIndex === -1) {
    throw new ModeParseError(
      `Mode file frontmatter is missing the closing '---' delimiter: ${filePath}`
    );
  }

  const yamlText = lines.slice(1, endIndex).join("\n");
  const body = lines
    .slice(endIndex + 1)
    .join("\n")
    .trim();

  let raw: unknown;
  try {
    raw = YAML.parse(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ModeParseError(`Failed to parse mode YAML frontmatter: ${message}`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModeParseError(`Mode YAML frontmatter must be a mapping/object: ${filePath}`);
  }

  const parsed = ModeFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ModeParseError(`Invalid mode frontmatter: ${formatZodIssues(parsed.error.issues)}`);
  }

  return { frontmatter: parsed.data, body };
}

export class ModeLoaderService {
  private builtinModes = new Map<string, ModeDefinition>();

  constructor(private readonly config: Config) {}

  /**
   * Initialize by loading built-in modes from the bundled files.
   */
  async initialize(): Promise<void> {
    await this.loadBuiltinModes();
  }

  private async loadBuiltinModes(): Promise<void> {
    // Built-in modes are bundled with the app in src/node/builtinModes/
    // This file is in src/node/services/, so we need to go up one level
    const builtinDir = path.join(__dirname, "..", "builtinModes");

    let files: string[];
    try {
      files = await fs.readdir(builtinDir);
    } catch {
      log.warn(`Built-in modes directory not found: ${builtinDir}`);
      return;
    }

    for (const file of files) {
      if (!file.endsWith(MODE_FILE_EXTENSION)) continue;

      const filePath = path.join(builtinDir, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const parsed = parseModeMarkdown(content, filePath);

        const mode: ModeDefinition = {
          ...parsed.frontmatter,
          instructions: parsed.body,
          source: "builtin",
          filePath,
        };

        const validated = ModeDefinitionSchema.safeParse(mode);
        if (!validated.success) {
          log.warn(`Invalid built-in mode ${file}: ${formatZodIssues(validated.error.issues)}`);
          continue;
        }

        this.builtinModes.set(validated.data.name, validated.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to load built-in mode ${file}: ${message}`);
      }
    }

    log.debug(`Loaded ${this.builtinModes.size} built-in modes`);
  }

  /**
   * Discover all available modes for a project.
   * Priority: project > global > builtin
   * Modes with disabled: true are filtered out.
   */
  async discoverModes(runtime: Runtime, workspacePath: string): Promise<ModeDefinition[]> {
    const byName = new Map<string, ModeDefinition>();
    const disabledModes = new Set<string>();

    // Start with built-in modes
    for (const [name, mode] of this.builtinModes) {
      byName.set(name, mode);
    }

    // Load global modes (~/.mux/modes/)
    const globalRoot = path.join(this.config.rootDir, GLOBAL_MODES_DIR);
    const globalModes = await this.loadModesFromDir(runtime, globalRoot, "global", workspacePath);
    for (const mode of globalModes) {
      if (mode.disabled) {
        disabledModes.add(mode.name);
      } else {
        byName.set(mode.name, mode);
      }
    }

    // Load project modes (.mux/modes/)
    const projectRoot = runtime.normalizePath(PROJECT_MODES_DIR, workspacePath);
    const projectModes = await this.loadModesFromDir(
      runtime,
      projectRoot,
      "project",
      workspacePath
    );
    for (const mode of projectModes) {
      if (mode.disabled) {
        disabledModes.add(mode.name);
        byName.delete(mode.name);
      } else {
        byName.set(mode.name, mode);
      }
    }

    // Remove disabled modes
    for (const name of disabledModes) {
      byName.delete(name);
    }

    // Sort: exec first, plan second, then alphabetically
    const modes = Array.from(byName.values());
    return modes.sort((a, b) => {
      if (a.name === "exec") return -1;
      if (b.name === "exec") return 1;
      if (a.name === "plan") return -1;
      if (b.name === "plan") return 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Get a specific mode by name.
   */
  async getMode(
    runtime: Runtime,
    workspacePath: string,
    modeName: string
  ): Promise<ModeDefinition | null> {
    const modes = await this.discoverModes(runtime, workspacePath);
    return modes.find((m) => m.name === modeName) ?? null;
  }

  private async loadModesFromDir(
    runtime: Runtime,
    root: string,
    source: ModeSource,
    workspacePath: string
  ): Promise<ModeDefinition[]> {
    const modes: ModeDefinition[] = [];

    let resolvedRoot: string;
    try {
      resolvedRoot = await runtime.resolvePath(root);
    } catch {
      return modes;
    }

    let files: string[];
    try {
      if (runtime instanceof SSHRuntime) {
        files = await this.listModeFilesFromRuntime(runtime, resolvedRoot, workspacePath);
      } else {
        files = await this.listModeFilesFromLocalFs(resolvedRoot);
      }
    } catch {
      return modes;
    }

    for (const file of files) {
      if (!file.endsWith(MODE_FILE_EXTENSION)) continue;

      const filePath = runtime.normalizePath(file, resolvedRoot);
      try {
        const stat = await runtime.stat(filePath);
        if (stat.isDirectory) continue;

        const sizeValidation = validateFileSize(stat);
        if (sizeValidation) {
          log.warn(`Skipping mode file ${file}: ${sizeValidation.error}`);
          continue;
        }

        const content = await readFileString(runtime, filePath);
        const parsed = parseModeMarkdown(content, filePath);

        // Verify filename matches mode name
        const expectedName = file.replace(MODE_FILE_EXTENSION, "");
        if (parsed.frontmatter.name !== expectedName) {
          log.warn(
            `Mode file ${file} has mismatched name: expected '${expectedName}', got '${parsed.frontmatter.name}'`
          );
          continue;
        }

        const mode: ModeDefinition = {
          ...parsed.frontmatter,
          instructions: parsed.body,
          source,
          filePath,
        };

        const validated = ModeDefinitionSchema.safeParse(mode);
        if (!validated.success) {
          log.warn(`Invalid mode ${file}: ${formatZodIssues(validated.error.issues)}`);
          continue;
        }

        modes.push(validated.data);
      } catch (err) {
        const message = err instanceof ModeParseError ? err.message : String(err);
        log.warn(`Skipping invalid mode file ${file}: ${message}`);
      }
    }

    return modes;
  }

  private async listModeFilesFromLocalFs(root: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(MODE_FILE_EXTENSION))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async listModeFilesFromRuntime(
    runtime: Runtime,
    root: string,
    cwd: string
  ): Promise<string[]> {
    const quotedRoot = shellQuote(root);
    const command =
      `if [ -d ${quotedRoot} ]; then ` +
      `find ${quotedRoot} -maxdepth 1 -name '*.md' -type f -exec basename {} \\; ; ` +
      `fi`;

    const result = await execBuffered(runtime, command, { cwd, timeout: 10 });
    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Get the instructions for a mode, with template substitution.
   */
  getInstructionsWithContext(
    mode: ModeDefinition,
    context: { planFilePath?: string; planExists?: boolean }
  ): string {
    let instructions = mode.instructions;

    // Handle plan file status template for plan mode
    if (context.planFilePath !== undefined) {
      const planFileStatus = context.planExists
        ? `A plan file already exists at ${context.planFilePath}. First, read it to determine if it's relevant to the current request. If the current request is unrelated to the existing plan, delete the file and start fresh. If relevant, make incremental edits using the file_edit_* tools.`
        : `No plan file exists yet. You should create your plan at ${context.planFilePath} using the file_edit_* tools.`;

      instructions = instructions.replace("{{planFileStatus}}", planFileStatus);
    }

    return instructions;
  }
}
