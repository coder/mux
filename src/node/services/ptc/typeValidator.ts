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

import ts from "typescript";

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
    lib: ["lib.es2020.d.ts"], // Need real lib for Array, Promise, etc.
  };

  const sourceFile = ts.createSourceFile("agent.ts", wrappedCode, ts.ScriptTarget.ES2020, true);

  // Use real compiler host (provides lib files) with our source file injected
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);

  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === "agent.ts") return sourceFile;
    return originalGetSourceFile(fileName, languageVersion);
  };
  host.fileExists = (fileName) => {
    if (fileName === "agent.ts") return true;
    return originalFileExists(fileName);
  };

  const program = ts.createProgram(["agent.ts"], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  // Filter to errors in our code only (not lib files)
  // Also filter console redeclaration warning (our minimal console conflicts with lib.dom)
  const errors: TypeValidationError[] = diagnostics
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .filter((d) => !d.file || d.file.fileName === "agent.ts")
    .filter((d) => !ts.flattenDiagnosticMessageText(d.messageText, "").includes("console"))
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
