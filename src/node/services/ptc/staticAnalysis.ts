/**
 * Static Analysis for PTC Code
 *
 * Analyzes agent-generated JavaScript code before execution to catch:
 * - Syntax errors (via QuickJS parser)
 * - Forbidden constructs (import(), require())
 * - Unavailable globals (process, window, fetch, etc.)
 *
 * Runtime still wraps real ReferenceErrors with friendlier messages as a backstop.
 */

import ts from "typescript";
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
} from "quickjs-emscripten-core";
import { QuickJSAsyncFFI } from "@jitl/quickjs-wasmfile-release-asyncify/ffi";
import { validateTypes, WRAPPER_PREFIX } from "./typeValidator";

/**
 * Identifiers that don't exist in QuickJS and will cause ReferenceError.
 * Exported for runtime backstop error enhancement.
 */
export const UNAVAILABLE_IDENTIFIERS = new Set([
  // Node.js globals
  "process",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  // Browser globals
  "window",
  "document",
  "navigator",
  "fetch",
  "XMLHttpRequest",
]);

const WRAPPER_LINE_OFFSET = WRAPPER_PREFIX.split("\n").length - 1;

// ============================================================================
// Types
// ============================================================================

export interface AnalysisError {
  type: "syntax" | "forbidden_construct" | "unavailable_global" | "type_error";
  message: string;
  line?: number;
  column?: number;
}

export interface AnalysisResult {
  /** Whether the code passed all checks (no errors) */
  valid: boolean;
  /** Errors that prevent execution */
  errors: AnalysisError[];
}

// ============================================================================
// Pattern Definitions
// ============================================================================

// NOTE: We intentionally avoid regex scanning for substrings like "require(" or "import("
// because those can appear inside string literals and cause false positives.
//
// Instead, we use the TypeScript AST in detectUnavailableGlobals() to detect actual
// call expressions (require(), import()) and unavailable global identifier references.

// ============================================================================
// QuickJS Context Management
// ============================================================================

let cachedContext: QuickJSAsyncContext | null = null;

/**
 * Get or create a QuickJS context for syntax validation.
 * We reuse the context to avoid repeated WASM initialization.
 */
async function getValidationContext(): Promise<QuickJSAsyncContext> {
  if (cachedContext) {
    return cachedContext;
  }

  const variant = {
    type: "async" as const,
    importFFI: () => Promise.resolve(QuickJSAsyncFFI),
    // eslint-disable-next-line @typescript-eslint/require-await
    importModuleLoader: async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const mod = require("@jitl/quickjs-wasmfile-release-asyncify/emscripten-module");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
      return mod.default ?? mod;
    },
  };

  const QuickJS = await newQuickJSAsyncWASMModuleFromVariant(variant);
  cachedContext = QuickJS.newContext();
  return cachedContext;
}

// ============================================================================
// Analysis Functions
// ============================================================================

/**
 * Validate JavaScript syntax using QuickJS parser.
 * Returns syntax error if code is invalid.
 */
async function validateSyntax(code: string): Promise<AnalysisError | null> {
  const ctx = await getValidationContext();

  // Wrap in function to allow return statements (matches runtime behavior)
  const wrappedCode = `(function() { ${code} })`;

  // Use evalCode with compile-only flag to parse without executing.
  const result = ctx.evalCode(wrappedCode, "analysis.js", {
    compileOnly: true,
  });

  if (result.error) {
    const errorObj = ctx.dump(result.error) as Record<string, unknown>;
    result.error.dispose();

    // QuickJS error object has: { name, message, stack, fileName, lineNumber }
    let message =
      typeof errorObj.message === "string" ? errorObj.message : JSON.stringify(errorObj);

    // Enhance obtuse "expecting ';'" error when await expression is detected.
    // In non-async context, `await foo()` parses as identifier `await` + stray `foo()`,
    // giving unhelpful "expecting ';'". Detect this pattern and give a clearer message.
    if (message === "expecting ';'" && /\bawait\s+\w/.test(code)) {
      message =
        "`await` is not supported - mux.* functions return results directly (no await needed)";
    }
    const rawLine = typeof errorObj.lineNumber === "number" ? errorObj.lineNumber : undefined;

    // Only report line if it's within agent code bounds.
    // The wrapper is `(function() { ${code} })` - all on one line with code inlined.
    // So QuickJS line N = agent line N for lines within the code.
    // Errors detected at the closing wrapper (missing braces, incomplete expressions)
    // will have line numbers beyond the agent's code - don't report those.
    const codeLines = code.split("\n").length;
    const line =
      rawLine !== undefined && rawLine >= 1 && rawLine <= codeLines ? rawLine : undefined;

    return {
      type: "syntax",
      message,
      line,
      column: undefined, // QuickJS doesn't provide column for syntax errors
    };
  }

  result.value.dispose();
  return null;
}

/**
 * Detect forbidden constructs (import(), require()) and unavailable globals
 * using TypeScript AST to avoid false positives inside string literals.
 */
function detectUnavailableGlobals(code: string, sourceFile?: ts.SourceFile): AnalysisError[] {
  const errors: AnalysisError[] = [];
  const seen = new Set<string>();

  const parsedSourceFile =
    sourceFile ?? ts.createSourceFile("code.ts", code, ts.ScriptTarget.ES2020, true);
  const codeStartOffset = sourceFile ? WRAPPER_PREFIX.length : 0;
  const codeEnd = codeStartOffset + code.length;
  const lineOffset = sourceFile ? WRAPPER_LINE_OFFSET : 0;

  // Pre-scan: collect declarations that shadow unavailable globals, tracking their
  // lexical scope. A reference is only suppressed when the declaration is visible
  // at the reference site — this avoids false positives (`const fetch = mux.bash(...);
  // fetch.output`) while still catching out-of-scope references
  // (`if (true) { const process = {}; } process.env;`).
  const declarationScopes = new Map<string, Set<ts.Node>>();

  function addDeclScope(declName: string, scope: ts.Node): void {
    let scopes = declarationScopes.get(declName);
    if (!scopes) {
      scopes = new Set();
      declarationScopes.set(declName, scopes);
    }
    scopes.add(scope);
  }

  // The scope container for a declaration: the smallest AST ancestor that
  // encompasses both the declaration identifier and all valid reference sites.
  // The AST structure naturally encodes this — walk up from the declaration's
  // parent to the first scope-creating node. No special-casing needed.
  function findDeclScope(declNode: ts.Node): ts.Node {
    let current = declNode.parent;
    while (current) {
      if (
        ts.isFunctionLike(current) ||
        ts.isCatchClause(current) ||
        ts.isForInStatement(current) ||
        ts.isForOfStatement(current) ||
        ts.isForStatement(current) ||
        ts.isBlock(current) ||
        ts.isSourceFile(current)
      ) {
        return current;
      }
      current = current.parent;
    }
    return parsedSourceFile;
  }

  function collectDeclarations(node: ts.Node): void {
    let name: string | undefined;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
    }
    if (name && UNAVAILABLE_IDENTIFIERS.has(name)) {
      addDeclScope(name, findDeclScope(node));
    }
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(parsedSourceFile);

  // Check whether a name has a visible declaration at the reference site.
  function isDeclaredInScope(name: string, refNode: ts.Node): boolean {
    const scopes = declarationScopes.get(name);
    if (!scopes) return false;
    let current: ts.Node | undefined = refNode;
    while (current) {
      if (scopes.has(current)) return true;
      current = current.parent;
    }
    return false;
  }

  function visit(node: ts.Node): void {
    // If the node isn't within the user-authored code region (e.g., inside the wrapper prefix),
    // keep traversing but don't report errors for it.
    const nodeStart = node.getStart(parsedSourceFile);
    const nodeEnd = node.end;
    if (nodeStart < codeStartOffset || nodeEnd > codeEnd) {
      ts.forEachChild(node, visit);
      return;
    }

    // Detect forbidden constructs via AST (avoids false positives inside string literals).
    //
    // - dynamic import(): ts.CallExpression whose expression is the ImportKeyword
    // - require(): ts.CallExpression whose expression is identifier "require"
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!seen.has("import()")) {
          seen.add("import()");
          const { line } = parsedSourceFile.getLineAndCharacterOfPosition(
            node.expression.getStart(parsedSourceFile)
          );
          errors.push({
            type: "forbidden_construct",
            message: "Dynamic import() is not available in the sandbox",
            line: line - lineOffset + 1,
          });
        }
        ts.forEachChild(node, visit);
        return;
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        if (!seen.has("require()")) {
          seen.add("require()");
          const { line } = parsedSourceFile.getLineAndCharacterOfPosition(
            node.expression.getStart(parsedSourceFile)
          );
          errors.push({
            type: "forbidden_construct",
            message: "require() is not available in the sandbox - use mux.* tools instead",
            line: line - lineOffset + 1,
          });
        }
        ts.forEachChild(node, visit);
        return;
      }
    }

    // --- Unavailable global identifier detection ---

    // Only check identifier nodes
    if (!ts.isIdentifier(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const start = nodeStart;
    const name = node.text;

    // Skip 'require' identifier references — we only want to error on require() calls.
    if (name === "require") {
      return;
    }

    // Skip if not an unavailable identifier
    if (!UNAVAILABLE_IDENTIFIERS.has(name)) {
      return;
    }

    // Skip if already reported
    if (seen.has(name)) {
      return;
    }

    const parent = node.parent;

    // Skip identifiers used as property names, not variable references.
    // e.g., obj.process (property access RHS), { process: ... } (object key)
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
      return;
    }
    if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
      return;
    }

    // Skip if a local declaration shadows this name at the reference site.
    // Covers both declaration-site identifiers (const fetch = ..., function process() {},
    // parameters) and references to those locally-declared variables (fetch.output).
    if (isDeclaredInScope(name, node)) {
      return;
    }

    // This is a real reference to an unavailable global
    seen.add(name);
    const { line } = parsedSourceFile.getLineAndCharacterOfPosition(start);
    errors.push({
      type: "unavailable_global",
      message: `'${name}' is not available in the sandbox`,
      line: line - lineOffset + 1,
    });
  }

  visit(parsedSourceFile);
  return errors;
}

// ============================================================================
// Main Analysis Function
// ============================================================================

/**
 * Analyze JavaScript code before execution.
 *
 * Performs:
 * 1. Syntax validation via QuickJS parser
 * 2. Forbidden construct and unavailable global detection via TypeScript AST
 * 3. TypeScript type validation (if muxTypes provided)
 *
 * @param code - JavaScript code to analyze
 * @param muxTypes - Optional .d.ts content for type validation
 * @returns Analysis result with errors
 */
export async function analyzeCode(code: string, muxTypes?: string): Promise<AnalysisResult> {
  const errors: AnalysisError[] = [];

  // 1. Syntax validation
  const syntaxError = await validateSyntax(code);
  if (syntaxError) {
    errors.push(syntaxError);
    // If syntax is invalid, skip other checks (they'd give false positives)
    return { valid: false, errors };
  }

  let typeResult: ReturnType<typeof validateTypes> | undefined;
  if (muxTypes) {
    typeResult = validateTypes(code, muxTypes);
  }

  // 2. Forbidden construct and unavailable global detection
  errors.push(...detectUnavailableGlobals(code, typeResult?.sourceFile));

  // 3. TypeScript type validation (if muxTypes provided)
  if (typeResult) {
    for (const typeError of typeResult.errors) {
      errors.push({
        type: "type_error",
        message: typeError.message,
        line: typeError.line,
        column: typeError.column,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Clean up the cached validation context.
 * Call this when shutting down to free resources.
 *
 * TODO: Wire into app/workspace shutdown to free QuickJS context (Phase 6)
 */
export function disposeAnalysisContext(): void {
  if (cachedContext) {
    cachedContext.dispose();
    cachedContext = null;
  }
}
