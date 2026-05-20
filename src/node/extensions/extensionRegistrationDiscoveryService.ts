import { constants as fsConstants } from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

import { z } from "zod";
import ts from "typescript";

import type {
  ExtensionDiagnostic,
  ValidatedContribution,
} from "@/common/extensions/manifestValidator";
import { RelativeBodyPathSchema } from "@/common/orpc/schemas/extension";
import { SkillNameSchema } from "@/common/orpc/schemas/agentSkill";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";

import { realpathOpenedFile } from "@/node/utils/openedFileRealpath";
import { validateFileSize } from "@/node/services/tools/fileCommon";
import type { IJSRuntime } from "@/node/services/ptc/runtime";
import type { PTCConsoleRecord } from "@/node/services/ptc/types";

const DISCOVERY_TIMEOUT_MS_DEFAULT = 2_000;
const DISCOVERY_MEMORY_BYTES_DEFAULT = 16 * 1024 * 1024;

const SkillRegistrationSchema = z
  .object({
    name: SkillNameSchema,
    bodyPath: RelativeBodyPathSchema,
    displayName: z.string().nullish(),
    description: z.string().nullish(),
    advertise: z.boolean().nullish(),
  })
  .strict();

export interface ExtensionActivationSession {
  abort(): void;
  dispose(): void;
}

class QuickJSExtensionActivationSession implements ExtensionActivationSession {
  private disposed = false;

  constructor(private readonly runtime: IJSRuntime) {}

  abort(): void {
    if (this.disposed) return;
    this.runtime.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    // Full Activation owns a long-lived QuickJS context. Aborting first makes
    // teardown explicit if future v1-safe handlers are still running.
    this.runtime.abort();
    this.runtime.dispose();
    this.disposed = true;
  }
}

export interface DiscoverExtensionRegistrationsInput {
  extensionName: string;
  entrypointPath: string;
  allowSkills: boolean;
  mode?: "discover" | "activate";
  now?: number;
  timeoutMs?: number;
}

export interface DiscoverExtensionRegistrationsResult {
  contributions: ValidatedContribution[];
  diagnostics: ExtensionDiagnostic[];
  activationSession?: ExtensionActivationSession;
}

function diagnostic(
  code: string,
  message: string,
  extensionId: string,
  occurredAt: number,
  severity: ExtensionDiagnostic["severity"] = "error"
): ExtensionDiagnostic {
  return { code, severity, message, extensionId, occurredAt };
}

function formatTsDiagnostic(tsDiagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(tsDiagnostic.messageText, "\n");
}

interface TranspiledExtensionModule {
  id: string;
  code: string;
}

class RegistrationBundleError extends Error {
  constructor(readonly diagnostics: ExtensionDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join("\n"));
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function toModuleId(rootRealPath: string, fileRealPath: string): string {
  const relativePath = path.relative(rootRealPath, fileRealPath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Extension relative import escapes Extension Module: ${fileRealPath}`);
  }
  return relativePath.split(path.sep).join("/");
}

function candidateModulePaths(basePath: string): string[] {
  if (path.extname(basePath)) return [basePath];
  return [
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
    path.join(basePath, "index.jsx"),
  ];
}

async function resolveRelativeModule(input: {
  fromFileRealPath: string;
  rootRealPath: string;
  specifier: string;
}): Promise<string> {
  const basePath = path.resolve(path.dirname(input.fromFileRealPath), input.specifier);
  for (const candidatePath of candidateModulePaths(basePath)) {
    let realPath: string;
    try {
      realPath = await fsPromises.realpath(candidatePath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) continue;
      throw error;
    }

    const relativePath = path.relative(input.rootRealPath, realPath);
    if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(
        `Relative import ${JSON.stringify(input.specifier)} resolves outside the Extension Module.`
      );
    }

    const stat = await fsPromises.stat(realPath);
    if (stat.isFile()) return realPath;
  }

  throw new Error(
    `Cannot resolve relative import ${JSON.stringify(input.specifier)} from ${input.fromFileRealPath}.`
  );
}

function getRequireSpecifiers(transpiledCode: string): string[] {
  const sourceFile = ts.createSourceFile(
    "extension.js",
    transpiledCode,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.JS
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const [specifier] = node.arguments;
      if (specifier && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function isContainedRealPath(rootRealPath: string, candidateRealPath: string): boolean {
  const relativePath = path.relative(rootRealPath, candidateRealPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function readContainedModuleSource(
  rootRealPath: string,
  fileRealPath: string
): Promise<string> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fsPromises.open(fileRealPath, fsConstants.O_RDONLY | noFollow);
  try {
    const openedRealPath = await realpathOpenedFile(handle, fileRealPath);
    if (
      path.normalize(openedRealPath) !== path.normalize(fileRealPath) ||
      !isContainedRealPath(rootRealPath, openedRealPath)
    ) {
      throw new Error("Opened Extension module resolves outside its validated path.");
    }

    const stat = await handle.stat();
    const sizeValidation = validateFileSize({
      size: stat.size,
      modifiedTime: stat.mtime,
      isDirectory: stat.isDirectory(),
    });
    if (sizeValidation) throw new Error(sizeValidation.error);
    return handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

async function buildTranspiledModuleGraph(input: {
  entrypointPath: string;
  extensionName: string;
  occurredAt: number;
}): Promise<{ entrypointId: string; modules: TranspiledExtensionModule[] }> {
  const rootRealPath = await fsPromises.realpath(path.dirname(input.entrypointPath));
  const modules = new Map<string, TranspiledExtensionModule>();

  const compileModule = async (fileRealPath: string): Promise<void> => {
    const id = toModuleId(rootRealPath, fileRealPath);
    if (modules.has(id)) return;

    let source: string;
    try {
      source = await readContainedModuleSource(rootRealPath, fileRealPath);
    } catch (error) {
      throw new RegistrationBundleError([
        diagnostic(
          "extension.discovery.read_failed",
          `Failed to read Extension module ${id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          input.extensionName,
          input.occurredAt
        ),
      ]);
    }

    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      reportDiagnostics: true,
    });
    const transpileDiagnostics = transpiled.diagnostics ?? [];
    if (transpileDiagnostics.length > 0) {
      throw new RegistrationBundleError(
        transpileDiagnostics.map((tsDiagnostic) =>
          diagnostic(
            "extension.discovery.transpile_failed",
            formatTsDiagnostic(tsDiagnostic),
            input.extensionName,
            input.occurredAt
          )
        )
      );
    }

    modules.set(id, { id, code: transpiled.outputText });
    for (const specifier of getRequireSpecifiers(transpiled.outputText)) {
      if (!specifier.startsWith(".")) {
        if (specifier.startsWith("mux:")) continue;
        throw new RegistrationBundleError([
          diagnostic(
            "extension.discovery.import_unsupported",
            `Extension imports must be mux:* virtual modules or contained relative imports in v1; bare import ${JSON.stringify(specifier)} is not allowed.`,
            input.extensionName,
            input.occurredAt
          ),
        ]);
      }
      const dependencyRealPath = await resolveRelativeModule({
        fromFileRealPath: fileRealPath,
        rootRealPath,
        specifier,
      });
      await compileModule(dependencyRealPath);
    }
  };

  const entrypointRealPath = await fsPromises.realpath(input.entrypointPath);
  await compileModule(entrypointRealPath);
  return {
    entrypointId: toModuleId(rootRealPath, entrypointRealPath),
    modules: [...modules.values()],
  };
}

function buildDiscoveryCode(input: {
  entrypointId: string;
  modules: readonly TranspiledExtensionModule[];
  mode: "discover" | "activate";
}): string {
  const moduleDefinitions = input.modules
    .map(
      (item) => `${JSON.stringify(item.id)}: function(module, exports, require) {\n${item.code}\n}`
    )
    .join(",\n");

  return `
function defineManifest(value) { return value; }
const __mux_moduleDefinitions = { ${moduleDefinitions} };
const __mux_moduleCache = {};
function __mux_dirname(id) {
  const index = id.lastIndexOf("/");
  return index === -1 ? "" : id.slice(0, index);
}
function __mux_normalize(value) {
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("Relative import escapes the Extension Module");
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}
function __mux_resolve(fromId, request) {
  if (!request.startsWith(".")) {
    throw new Error("Extension Registration Discovery supports only mux:* virtual imports and contained relative imports in v1: " + request);
  }
  const dir = __mux_dirname(fromId);
  const base = __mux_normalize((dir ? dir + "/" : "") + request);
  const explicitExtension = /\\.[cm]?[jt]sx?$/.test(base);
  const candidates = explicitExtension
    ? [base]
    : [
        base + ".ts",
        base + ".tsx",
        base + ".js",
        base + ".jsx",
        base + "/index.ts",
        base + "/index.tsx",
        base + "/index.js",
        base + "/index.jsx",
      ];
  for (const candidate of candidates) {
    if (__mux_moduleDefinitions[candidate]) return candidate;
  }
  throw new Error("Cannot resolve Extension relative import " + request + " from " + fromId);
}
function __mux_loadModule(id) {
  if (__mux_moduleCache[id]) return __mux_moduleCache[id].exports;
  const factory = __mux_moduleDefinitions[id];
  if (!factory) throw new Error("Unknown Extension module " + id);
  const module = { exports: {} };
  __mux_moduleCache[id] = module;
  factory(module, module.exports, function require(request) {
    if (request === "mux:extensions") return { defineManifest };
    return __mux_loadModule(__mux_resolve(id, request));
  });
  return module.exports;
}
const __mux_entrypoint = __mux_loadModule(${JSON.stringify(input.entrypointId)});
const __mux_activate =
  typeof __mux_entrypoint.activate === "function" ? __mux_entrypoint.activate : undefined;
return (async function __mux_run_activation() {
  if (__mux_activate) {
    await __mux_activate({
      mode: ${JSON.stringify(input.mode)},
      skills: {
        register(input) {
          const token = __mux_register_skill(input);
          return {
            dispose() {
              if (${JSON.stringify(input.mode)} === "activate") __mux_dispose_skill(token);
            }
          };
        },
      },
    });
  }
  return true;
})();
`;
}

function executionFailureCode(input: { message: string; mode: "discover" | "activate" }): string {
  if (input.message.includes("manifest.capabilities.skills")) {
    return "extension.capability.undeclared";
  }
  return input.mode === "activate" ? "extension.activation.failed" : "extension.discovery.failed";
}

function consoleSeverity(level: PTCConsoleRecord["level"]): ExtensionDiagnostic["severity"] {
  if (level === "log") return "info";
  if (level === "warn") return "warn";
  return "error";
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return value.toString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol")
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  if (typeof value === "function") return "[function]";
  try {
    const json = JSON.stringify(value);
    return json ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function consoleDiagnostics(input: {
  records: readonly PTCConsoleRecord[];
  mode: "discover" | "activate";
  extensionName: string;
  occurredAt: number;
}): ExtensionDiagnostic[] {
  const phase = input.mode === "activate" ? "Full Activation" : "Registration Discovery";
  const code =
    input.mode === "activate" ? "extension.activation.console" : "extension.discovery.console";
  return input.records.map((record) => ({
    code,
    severity: consoleSeverity(record.level),
    message: `${phase} console.${record.level}: ${record.args.map(formatConsoleArg).join(" ")}`,
    extensionId: input.extensionName,
    occurredAt: input.occurredAt,
  }));
}

export async function discoverExtensionRegistrations(
  input: DiscoverExtensionRegistrationsInput
): Promise<DiscoverExtensionRegistrationsResult> {
  const occurredAt = input.now ?? Date.now();
  let moduleGraph: { entrypointId: string; modules: TranspiledExtensionModule[] };
  try {
    moduleGraph = await buildTranspiledModuleGraph({
      entrypointPath: input.entrypointPath,
      extensionName: input.extensionName,
      occurredAt,
    });
  } catch (error) {
    if (error instanceof RegistrationBundleError) {
      return { contributions: [], diagnostics: error.diagnostics };
    }
    return {
      contributions: [],
      diagnostics: [
        diagnostic(
          "extension.discovery.failed",
          error instanceof Error ? error.message : String(error),
          input.extensionName,
          occurredAt
        ),
      ],
    };
  }

  const disposedContributionIndexes = new Set<number>();
  const contributions: ValidatedContribution[] = [];
  const mode = input.mode ?? "discover";
  let runtime: IJSRuntime;
  try {
    runtime = await new QuickJSRuntimeFactory().create();
  } catch (error) {
    return {
      contributions: [],
      diagnostics: [
        diagnostic(
          mode === "activate" ? "extension.activation.failed" : "extension.discovery.failed",
          `Failed to initialize extension sandbox: ${error instanceof Error ? error.message : String(error)}`,
          input.extensionName,
          occurredAt
        ),
      ],
    };
  }
  let keepRuntime = false;
  try {
    runtime.setLimits({
      memoryBytes: DISCOVERY_MEMORY_BYTES_DEFAULT,
      timeoutMs: input.timeoutMs ?? DISCOVERY_TIMEOUT_MS_DEFAULT,
    });
    runtime.registerFunction("__mux_register_skill", (registrationInput: unknown) => {
      if (!input.allowSkills) {
        throw new Error(
          "manifest.capabilities.skills must be true before ctx.skills.register is used"
        );
      }
      const parsed = SkillRegistrationSchema.safeParse(registrationInput);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const index = contributions.length;
      const descriptor: Record<string, unknown> = {
        descriptorVersion: 1,
        id: parsed.data.name,
        body: parsed.data.bodyPath,
      };
      if (typeof parsed.data.displayName === "string")
        descriptor.displayName = parsed.data.displayName;
      if (typeof parsed.data.description === "string")
        descriptor.description = parsed.data.description;
      if (typeof parsed.data.advertise === "boolean") descriptor.advertise = parsed.data.advertise;
      contributions.push({
        type: "skills",
        id: parsed.data.name,
        index,
        descriptor,
      });
      return Promise.resolve(index);
    });
    runtime.registerFunction("__mux_dispose_skill", (token: unknown) => {
      if (input.mode === "activate" && typeof token === "number") {
        disposedContributionIndexes.add(token);
      }
      return Promise.resolve(null);
    });

    const result = await runtime.eval(
      buildDiscoveryCode({
        entrypointId: moduleGraph.entrypointId,
        modules: moduleGraph.modules,
        mode,
      })
    );
    const capturedConsole = consoleDiagnostics({
      records: result.consoleOutput,
      mode,
      extensionName: input.extensionName,
      occurredAt,
    });
    if (!result.success) {
      const message =
        result.error ??
        (mode === "activate" ? "Full Activation failed." : "Registration Discovery failed.");
      const code = executionFailureCode({ message, mode });
      return {
        contributions: [],
        diagnostics: [
          ...capturedConsole,
          diagnostic(code, message, input.extensionName, occurredAt),
        ],
      };
    }
    const activeContributions = contributions.filter(
      (_, index) => !disposedContributionIndexes.has(index)
    );
    const activationSession =
      mode === "activate" ? new QuickJSExtensionActivationSession(runtime) : undefined;
    keepRuntime = activationSession !== undefined;
    return {
      contributions: activeContributions,
      diagnostics: capturedConsole,
      activationSession,
    };
  } finally {
    if (!keepRuntime) runtime.dispose();
  }
}
