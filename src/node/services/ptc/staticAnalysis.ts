/**
 * Static Analysis for PTC Code
 *
 * Analyzes agent-generated JavaScript code before execution to catch:
 * - Syntax errors (via QuickJS parser)
 * - Unavailable constructs (import(), require())
 * - Unavailable globals (process, window, etc.)
 *
 * The runtime also wraps ReferenceErrors with friendlier messages as a backstop.
 */

import ts from "typescript";
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
} from "quickjs-emscripten-core";
import { QuickJSAsyncFFI } from "@jitl/quickjs-wasmfile-release-asyncify/ffi";
import { validateTypes } from "./typeValidator";

/**
 * Identifiers that don't exist in QuickJS and will cause ReferenceError.
 * Used by static analysis to block execution, and by runtime for friendly error messages.
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

/**
 * Patterns that will fail at runtime in QuickJS.
 * We detect these early to give better error messages.
 */
const UNAVAILABLE_PATTERNS: Array<{
  pattern: RegExp;
  type: AnalysisError["type"];
  message: (match: RegExpMatchArray) => string;
}> = [
  {
    // Dynamic import() - not supported in QuickJS, causes crash
    pattern: /(?<![.\w])import\s*\(/g,
    type: "forbidden_construct",
    message: () => "Dynamic import() is not available in the sandbox",
  },
  {
    // require() - CommonJS import, not in QuickJS
    pattern: /(?<![.\w])require\s*\(/g,
    type: "forbidden_construct",
    message: () => "require() is not available in the sandbox - use mux.* tools instead",
  },
];

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
 * Find line number for a match position in the source code.
 */
function getLineNumber(code: string, index: number): number {
  const upToMatch = code.slice(0, index);
  return (upToMatch.match(/\n/g) ?? []).length + 1;
}

/**
 * Detect patterns that will fail at runtime in QuickJS.
 */
function detectUnavailablePatterns(code: string): AnalysisError[] {
  const errors: AnalysisError[] = [];

  for (const { pattern, type, message } of UNAVAILABLE_PATTERNS) {
    // Reset regex state for each scan
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(code)) !== null) {
      errors.push({
        type,
        message: message(match),
        line: getLineNumber(code, match.index),
      });
    }
  }

  return errors;
}

/**
 * Detect references to unavailable globals (process, window, fetch, etc.)
 * using TypeScript AST to avoid false positives on object keys and string literals.
 */
function detectUnavailableGlobals(code: string): AnalysisError[] {
  const errors: AnalysisError[] = [];
  const seen = new Set<string>();

  const sourceFile = ts.createSourceFile("code.ts", code, ts.ScriptTarget.ES2020, true);

  function visit(node: ts.Node): void {
    // Only check identifier nodes
    if (!ts.isIdentifier(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const name = node.text;

    // Skip 'require' - already handled as forbidden_construct pattern
    if (name === "require") {
      ts.forEachChild(node, visit);
      return;
    }

    // Skip if not an unavailable identifier
    if (!UNAVAILABLE_IDENTIFIERS.has(name)) {
      ts.forEachChild(node, visit);
      return;
    }

    // Skip if already reported
    if (seen.has(name)) {
      ts.forEachChild(node, visit);
      return;
    }

    const parent = node.parent;

    // Skip property access on RHS (e.g., obj.process)
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
      ts.forEachChild(node, visit);
      return;
    }

    // Skip object literal property keys (e.g., { process: ... })
    if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
      ts.forEachChild(node, visit);
      return;
    }

    // Skip shorthand property assignments (e.g., { process } where process is a variable)
    // This is actually a reference, so we don't skip it

    // Skip variable declarations (e.g., const process = ...)
    if (parent && ts.isVariableDeclaration(parent) && parent.name === node) {
      ts.forEachChild(node, visit);
      return;
    }

    // Skip function declarations (e.g., function process() {})
    if (parent && ts.isFunctionDeclaration(parent) && parent.name === node) {
      ts.forEachChild(node, visit);
      return;
    }

    // Skip parameter declarations
    if (parent && ts.isParameter(parent) && parent.name === node) {
      ts.forEachChild(node, visit);
      return;
    }

    // This is a real reference to an unavailable global
    seen.add(name);
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    errors.push({
      type: "unavailable_global",
      message: `'${name}' is not available in the sandbox`,
      line: line + 1, // 1-indexed
    });

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
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
 * 2. Unavailable pattern detection (import, require)
 * 3. Unavailable global detection (process, window, etc.)
 * 4. TypeScript type validation (if muxTypes provided)
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

  // 2. Unavailable pattern detection (import, require)
  errors.push(...detectUnavailablePatterns(code));

  // 3. Unavailable global detection (process, window, etc.)
  errors.push(...detectUnavailableGlobals(code));

  // 4. TypeScript type validation (if muxTypes provided)
  if (muxTypes) {
    const typeResult = validateTypes(code, muxTypes);
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
