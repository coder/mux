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

export const WRAPPER_PREFIX = "function __agent__() {\n";
const MUX_TYPES_FILE = "mux.d.ts";
const ROOT_FILE_NAMES = ["agent.ts", MUX_TYPES_FILE];

// Cache lib and mux type SourceFiles across validations to avoid re-parsing.
const libSourceFileCache = new Map<string, ts.SourceFile>();
const muxSourceFileCache = new Map<string, ts.SourceFile>();

function wrapAgentCode(code: string): string {
  return `${WRAPPER_PREFIX}${code}\n}\n`;
}

const getLibCacheKey = (fileName: string, languageVersion: ts.ScriptTarget): string =>
  `${languageVersion}:${fileName}`;

function getCachedLibSourceFile(
  fileName: string,
  languageVersion: ts.ScriptTarget,
  readFile: () => string | undefined
): ts.SourceFile | undefined {
  const key = getLibCacheKey(fileName, languageVersion);
  const cached = libSourceFileCache.get(key);
  if (cached) return cached;

  const contents = readFile();
  if (!contents) return undefined;

  const sourceFile = ts.createSourceFile(fileName, contents, languageVersion, true);
  libSourceFileCache.set(key, sourceFile);
  return sourceFile;
}

function getCachedMuxSourceFile(muxTypes: string, languageVersion: ts.ScriptTarget): ts.SourceFile {
  const key = `${languageVersion}:${muxTypes}`;
  const cached = muxSourceFileCache.get(key);
  if (cached) return cached;

  const sourceFile = ts.createSourceFile(MUX_TYPES_FILE, muxTypes, languageVersion, true);
  muxSourceFileCache.set(key, sourceFile);
  return sourceFile;
}
/** Resolve lib file path, accounting for .d.ts rename in production */
const resolveLibPath = (fileName: string): string => {
  const libFileName = path.basename(fileName);
  const actualName = IS_PRODUCTION ? toProductionLibName(libFileName) : libFileName;
  return path.join(LIB_DIR, actualName);
};

function createProgramForCode(
  wrappedCode: string,
  muxTypes: string,
  compilerOptions: ts.CompilerOptions
): {
  program: ts.Program;
  host: ts.CompilerHost;
  getSourceFile: () => ts.SourceFile;
  setSourceFile: (newWrappedCode: string) => void;
} {
  const scriptTarget = compilerOptions.target ?? ts.ScriptTarget.ES2020;
  let sourceFile = ts.createSourceFile("agent.ts", wrappedCode, scriptTarget, true);
  const muxSourceFile = getCachedMuxSourceFile(muxTypes, scriptTarget);
  const setSourceFile = (newWrappedCode: string) => {
    sourceFile = ts.createSourceFile("agent.ts", newWrappedCode, scriptTarget, true);
  };
  const host = ts.createCompilerHost(compilerOptions);

  // Override to read lib files from our bundled directory
  host.getDefaultLibLocation = () => LIB_DIR;
  host.getDefaultLibFileName = (options) => path.join(LIB_DIR, ts.getDefaultLibFileName(options));

  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const target = languageVersion ?? scriptTarget;
    if (fileName === "agent.ts") return sourceFile;
    if (fileName === MUX_TYPES_FILE) return muxSourceFile;

    const isLibFile = fileName.includes("lib.") && fileName.endsWith(".d.ts");
    if (isLibFile) {
      const cached = getCachedLibSourceFile(fileName, target, () => {
        if (IS_PRODUCTION) {
          const libPath = resolveLibPath(fileName);
          return fs.existsSync(libPath) ? fs.readFileSync(libPath, "utf-8") : undefined;
        }
        return originalReadFile(fileName) ?? undefined;
      });
      if (cached) return cached;
    }

    return originalGetSourceFile(fileName, target, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => {
    if (fileName === "agent.ts" || fileName === MUX_TYPES_FILE) return true;
    // In production, check bundled lib directory for lib files
    if (IS_PRODUCTION && fileName.includes("lib.") && fileName.endsWith(".d.ts")) {
      return fs.existsSync(resolveLibPath(fileName));
    }
    return originalFileExists(fileName);
  };
  host.readFile = (fileName) => {
    if (fileName === MUX_TYPES_FILE) return muxTypes;
    // In production, read lib files from bundled directory
    if (IS_PRODUCTION && fileName.includes("lib.") && fileName.endsWith(".d.ts")) {
      const libPath = resolveLibPath(fileName);
      if (fs.existsSync(libPath)) {
        return fs.readFileSync(libPath, "utf-8");
      }
    }
    return originalReadFile(fileName);
  };

  const program = ts.createProgram(ROOT_FILE_NAMES, compilerOptions, host);
  return { program, host, getSourceFile: () => sourceFile, setSourceFile };
}

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
  sourceFile?: ts.SourceFile;
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

/** Returns true if the type resolves to a non-tuple never[] (including unions). */
function isNeverArrayType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const nonNullable = checker.getNonNullableType(type);

  if (nonNullable.isUnion()) {
    return nonNullable.types.every((member) => isNeverArrayType(member, checker));
  }

  if (checker.isTupleType(nonNullable)) {
    return false;
  }

  if (!checker.isArrayType(nonNullable)) {
    return false;
  }

  const elementType = checker.getIndexTypeOfType(nonNullable, ts.IndexKind.Number);
  return elementType !== undefined && (elementType.flags & ts.TypeFlags.Never) !== 0;
}
/**
 * Check if an empty array literal has type context (annotation or assertion),
 * or is in a position where adding `as any[]` would be invalid.
 * If true, we should NOT add `as any[]`.
 */
function hasTypeContext(node: ts.ArrayLiteralExpression): boolean {
  const parent = node.parent;

  // Skip: `[] as Type` or `[] as const`
  if (ts.isAsExpression(parent)) return true;

  // Skip: `<Type[]>[]` (angle-bracket type assertion)
  if (ts.isTypeAssertionExpression(parent)) return true;

  // Note: We do NOT skip `[] satisfies Type[]` because satisfies only validates
  // compatibility without changing the inferred type (still never[] with our settings)

  // Skip: `const x: Type[] = []` (variable with type annotation)
  if (ts.isVariableDeclaration(parent) && parent.type) return true;

  // Skip: `const [] = x` (destructuring pattern - array is on LHS)
  if (ts.isArrayBindingPattern(parent)) return true;

  // Skip: `([] = foo)` (destructuring assignment - array on LHS of =)
  // Adding `as any[]` here would produce invalid syntax: `([] as any[] = foo)`
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === node
  ) {
    return true;
  }

  // Skip: `function f(x: Type[] = [])` (parameter with type annotation and default)
  if (ts.isParameter(parent) && parent.type) return true;

  return false;
}

function getNeverArrayLiteralStarts(
  code: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): Set<number> {
  const codeStart = WRAPPER_PREFIX.length;
  const codeEnd = codeStart + code.length;
  const starts = new Set<number>();

  function visit(node: ts.Node) {
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) {
      const start = node.getStart(sourceFile);
      if (start >= codeStart && node.end <= codeEnd) {
        // `satisfies` validates compatibility without changing the inferred type.
        const contextualType = ts.isSatisfiesExpression(node.parent)
          ? undefined
          : checker.getContextualType(node);
        const type = contextualType ?? checker.getTypeAtLocation(node);
        if (isNeverArrayType(type, checker)) {
          starts.add(start - codeStart);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return starts;
}

/**
 * Preprocess agent code to add type assertions to empty array literals.
 *
 * TypeScript infers `[]` as `never[]` when `strictNullChecks: true` and `noImplicitAny: false`.
 * This is documented behavior (GitHub issues #36987, #13140, #50505, #51979).
 * The TypeScript team recommends using type assertions: `[] as any[]`.
 *
 * This function transforms `[]` → `[] as any[]` for untyped empty arrays, enabling
 * all array operations (push, map, forEach, etc.) to work without type errors.
 */
function preprocessEmptyArrays(code: string, neverArrayStarts: Set<number>): string {
  if (neverArrayStarts.size === 0) {
    return code;
  }

  const sourceFile = ts.createSourceFile("temp.ts", code, ts.ScriptTarget.Latest, true);
  const edits: Array<{ pos: number; text: string }> = [];

  function visit(node: ts.Node) {
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) {
      const start = node.getStart(sourceFile);
      if (neverArrayStarts.has(start) && !hasTypeContext(node)) {
        const parent = node.parent;
        // `as` binds looser than unary operators, so wrap to keep the assertion on the literal.
        const needsParens =
          ts.isPropertyAccessExpression(parent) ||
          ts.isPropertyAccessChain(parent) ||
          ts.isElementAccessExpression(parent) ||
          ts.isElementAccessChain(parent) ||
          (ts.isCallExpression(parent) && parent.expression === node) ||
          (ts.isCallChain(parent) && parent.expression === node) ||
          ts.isPrefixUnaryExpression(parent) ||
          ts.isPostfixUnaryExpression(parent) ||
          ts.isTypeOfExpression(parent) ||
          ts.isVoidExpression(parent) ||
          ts.isDeleteExpression(parent) ||
          ts.isAwaitExpression(parent) ||
          ts.isYieldExpression(parent);

        if (needsParens) {
          edits.push({ pos: node.getStart(sourceFile), text: "(" });
          edits.push({ pos: node.end, text: " as any[])" });
        } else {
          edits.push({ pos: node.end, text: " as any[]" });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Apply edits in reverse order to preserve positions
  let result = code;
  for (const edit of edits.sort((a, b) => b.pos - a.pos)) {
    result = result.slice(0, edit.pos) + edit.text + result.slice(edit.pos);
  }
  return result;
}

export function validateTypes(code: string, muxTypes: string): TypeValidationResult {
  const compilerOptions: ts.CompilerOptions = {
    noEmit: true,
    strict: false, // Don't require explicit types on everything
    strictNullChecks: true, // Enable discriminated union narrowing (e.g., `if (!result.success) { result.error }`)
    noImplicitAny: false, // Allow any types
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    // ES2023 needed for Array.at(), findLast(), toSorted(), Object.hasOwn(), String.replaceAll()
    // QuickJS 0.31+ supports these features at runtime
    lib: ["lib.es2023.d.ts"],
  };

  // Preprocess empty arrays to avoid never[] inference without overriding contextual typing.
  const originalWrappedCode = wrapAgentCode(code);
  const {
    program: originalProgram,
    host,
    getSourceFile,
    setSourceFile,
  } = createProgramForCode(originalWrappedCode, muxTypes, compilerOptions);
  const originalSourceFile = getSourceFile();
  const neverArrayStarts = getNeverArrayLiteralStarts(
    code,
    originalSourceFile,
    originalProgram.getTypeChecker()
  );
  const preprocessedCode = preprocessEmptyArrays(code, neverArrayStarts);

  // Wrap code in function to allow return statements (matches runtime behavior)
  // Note: We don't use async because Asyncify makes mux.* calls appear synchronous
  // Types live in a separate virtual file so error line numbers match agent code directly.
  const wrappedCode = wrapAgentCode(preprocessedCode);

  let program = originalProgram;
  if (wrappedCode !== originalWrappedCode) {
    setSourceFile(wrappedCode);
    program = ts.createProgram(ROOT_FILE_NAMES, compilerOptions, host, originalProgram);
  }

  const sourceFile = program.getSourceFile("agent.ts") ?? getSourceFile();
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

  return { valid: errors.length === 0, errors, sourceFile: originalSourceFile };
}
