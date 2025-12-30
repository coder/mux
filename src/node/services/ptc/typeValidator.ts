/**
 * TypeScript Type Validator for PTC
 *
 * Validates agent-generated JavaScript code against generated type definitions.
 * Catches type errors before execution:
 * - Wrong property names
 * - Missing required arguments
 * - Wrong types for arguments
 * - Calling non-existent tools
 */

/* eslint-disable local/no-sync-fs-methods -- TypeScript's CompilerHost API requires synchronous file operations */
import fs from "fs";
import path from "path";
import ts from "typescript";

/**
 * In production builds, lib files are copied to dist/typescript-lib/ with .d.ts.txt extension
 * because electron-builder ignores .d.ts files by default (hardcoded, cannot override):
 * https://github.com/electron-userland/electron-builder/issues/5064
 *
 * These constants are computed once at module load time.
 */
const BUNDLED_LIB_DIR = path.resolve(__dirname, "../../../typescript-lib");
const IS_PRODUCTION = fs.existsSync(path.join(BUNDLED_LIB_DIR, "lib.es2023.d.ts.txt"));
const LIB_DIR = IS_PRODUCTION
  ? BUNDLED_LIB_DIR
  : path.dirname(require.resolve("typescript/lib/lib.d.ts"));

/** Convert lib filename for production: lib.X.d.ts → lib.X.d.ts.txt */
function toProductionLibName(fileName: string): string {
  return fileName + ".txt";
}

export interface TypeValidationError {
  message: string;
  line?: number;
  column?: number;
}

export interface TypeValidationResult {
  valid: boolean;
  errors: TypeValidationError[];
}

/**
 * Validate JavaScript code against mux type definitions using TypeScript.
 *
 * @param code - JavaScript code to validate
 * @param muxTypes - Generated `.d.ts` content from generateMuxTypes()
 * @returns Validation result with errors if any
 */

/**
 * Check if a TS2339 diagnostic is for a property WRITE on an empty object literal.
 * Returns true only for patterns like `results.foo = x` where `results` is typed as `{}`.
 * Returns false for reads like `return results.foo` or `fn(results.foo)`.
 */
function isEmptyObjectWriteError(d: ts.Diagnostic, sourceFile: ts.SourceFile): boolean {
  if (d.code !== 2339 || d.start === undefined) return false;
  const message = ts.flattenDiagnosticMessageText(d.messageText, "");
  if (!message.includes("on type '{}'")) return false;

  // Find the node at the error position and walk up to find context
  const token = findTokenAtPosition(sourceFile, d.start);
  if (!token) return false;

  // Walk up to find PropertyAccessExpression containing this token
  let propAccess: ts.PropertyAccessExpression | undefined;
  let node: ts.Node = token;
  while (node.parent) {
    if (ts.isPropertyAccessExpression(node.parent)) {
      propAccess = node.parent;
      break;
    }
    node = node.parent;
  }
  if (!propAccess) return false;

  // Check if this PropertyAccessExpression is on the left side of an assignment
  const parent = propAccess.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === propAccess
  ) {
    return true;
  }

  return false;
}

/** Find the innermost token at a position in the source file */
function findTokenAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  function find(node: ts.Node): ts.Node | undefined {
    if (position < node.getStart(sourceFile) || position >= node.getEnd()) {
      return undefined;
    }
    // Try to find a more specific child
    const child = ts.forEachChild(node, find);
    return child ?? node;
  }
  return find(sourceFile);
}

export function validateTypes(code: string, muxTypes: string): TypeValidationResult {
  // Wrap code in function to allow return statements (matches runtime behavior)
  // Note: We don't use async because Asyncify makes mux.* calls appear synchronous
  // Types go AFTER code so error line numbers match agent's code directly
  const wrapperPrefix = "function __agent__() {\n";
  const wrappedCode = `${wrapperPrefix}${code}
}

${muxTypes}
`;

  const compilerOptions: ts.CompilerOptions = {
    noEmit: true,
    strict: false, // Don't require explicit types on everything
    noImplicitAny: false, // Allow any types
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    // ES2023 needed for Array.at(), findLast(), toSorted(), Object.hasOwn(), String.replaceAll()
    // QuickJS 0.31+ supports these features at runtime
    lib: ["lib.es2023.d.ts"],
  };

  const sourceFile = ts.createSourceFile("agent.ts", wrappedCode, ts.ScriptTarget.ES2020, true);

  // Create compiler host with custom lib directory resolution.
  // In production, lib files are in dist/typescript-lib/ with .d-ts extension.
  const host = ts.createCompilerHost(compilerOptions);

  // Override to read lib files from our bundled directory
  host.getDefaultLibLocation = () => LIB_DIR;
  host.getDefaultLibFileName = (options) => path.join(LIB_DIR, ts.getDefaultLibFileName(options));

  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);

  /** Resolve lib file path, accounting for .d-ts rename in production */
  const resolveLibPath = (fileName: string): string => {
    const libFileName = path.basename(fileName);
    const actualName = IS_PRODUCTION ? toProductionLibName(libFileName) : libFileName;
    return path.join(LIB_DIR, actualName);
  };

  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === "agent.ts") return sourceFile;
    // In production, redirect lib file requests to our bundled directory (with .txt extension)
    // In development, let TypeScript use its default resolution so /// <reference lib="..." /> works
    if (IS_PRODUCTION && fileName.includes("lib.") && fileName.endsWith(".d.ts")) {
      const libPath = resolveLibPath(fileName);
      const content = fs.existsSync(libPath) ? fs.readFileSync(libPath, "utf-8") : undefined;
      if (content) {
        return ts.createSourceFile(fileName, content, languageVersion, true);
      }
    }
    return originalGetSourceFile(fileName, languageVersion);
  };
  host.fileExists = (fileName) => {
    if (fileName === "agent.ts") return true;
    // In production, check bundled lib directory for lib files
    if (IS_PRODUCTION && fileName.includes("lib.") && fileName.endsWith(".d.ts")) {
      return fs.existsSync(resolveLibPath(fileName));
    }
    return originalFileExists(fileName);
  };
  host.readFile = (fileName) => {
    // In production, read lib files from bundled directory
    if (IS_PRODUCTION && fileName.includes("lib.") && fileName.endsWith(".d.ts")) {
      const libPath = resolveLibPath(fileName);
      if (fs.existsSync(libPath)) {
        return fs.readFileSync(libPath, "utf-8");
      }
    }
    return originalReadFile(fileName);
  };

  const program = ts.createProgram(["agent.ts"], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  // Filter to errors in our code only (not lib files)
  // Also filter console redeclaration warning (our minimal console conflicts with lib.dom)
  const errors: TypeValidationError[] = diagnostics
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .filter((d) => !d.file || d.file.fileName === "agent.ts")
    .filter((d) => !ts.flattenDiagnosticMessageText(d.messageText, "").includes("console"))
    // Allow dynamic property WRITES on empty object literals - Claude frequently uses
    // `const results = {}; results.foo = mux.file_read(...)` to collate parallel reads.
    // Only suppress when the property access is on the LEFT side of an assignment.
    // Reads like `return results.typo` must still error.
    .filter((d) => !isEmptyObjectWriteError(d, sourceFile))
    .map((d) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
      // Extract line number if available
      if (d.file && d.start !== undefined) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        // TS line is 0-indexed. Wrapper adds 1 line before agent code, so:
        // TS line 0 = wrapper, TS line 1 = agent line 1, TS line 2 = agent line 2, etc.
        // This means TS 0-indexed line number equals agent 1-indexed line number.
        // Only report if within agent code bounds (filter out wrapper and muxTypes)
        const agentCodeLines = code.split("\n").length;
        if (line >= 1 && line <= agentCodeLines) {
          return { message, line, column: character + 1 };
        }
      }
      return { message };
    });

  return { valid: errors.length === 0, errors };
}
