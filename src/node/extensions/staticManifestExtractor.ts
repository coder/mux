import * as fsPromises from "fs/promises";

import ts from "typescript";

import { validateFileSize } from "@/node/services/tools/fileCommon";
import type { ExtensionDiagnostic } from "@/common/extensions/manifestValidator";

export type StaticManifestExtractionResult =
  | { ok: true; manifest: Record<string, unknown>; diagnostics: ExtensionDiagnostic[] }
  | { ok: false; diagnostics: ExtensionDiagnostic[] };

interface SourceFileWithParseDiagnostics extends ts.SourceFile {
  parseDiagnostics?: readonly ts.Diagnostic[];
}

function getParseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics ?? [];
}

function diagnostic(
  code: string,
  message: string,
  now: number,
  severity: ExtensionDiagnostic["severity"] = "error"
): ExtensionDiagnostic {
  return { code, severity, message, occurredAt: now };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function manifestInitializerToObjectLiteral(
  initializer: ts.Expression
): ts.ObjectLiteralExpression | null {
  const expression = unwrapExpression(initializer);
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (!ts.isCallExpression(expression)) return null;
  const callee = unwrapExpression(expression.expression);
  if (!ts.isIdentifier(callee) || callee.text !== "defineManifest") return null;
  if (expression.arguments.length !== 1) return null;
  const [arg] = expression.arguments;
  const unwrappedArg = unwrapExpression(arg);
  return ts.isObjectLiteralExpression(unwrappedArg) ? unwrappedArg : null;
}

function propertyNameToString(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return null;
}

function expressionToStaticValue(expression: ts.Expression): unknown {
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped))
    return unwrapped.text;
  if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (unwrapped.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isNumericLiteral(unwrapped)) return Number(unwrapped.text);
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.map((element) => {
      if (ts.isSpreadElement(element)) {
        throw new Error("Static Manifest arrays may only contain literal values.");
      }
      return expressionToStaticValue(element);
    });
  }
  if (ts.isObjectLiteralExpression(unwrapped)) return objectLiteralToRecord(unwrapped);
  throw new Error(
    "Static Manifest values must be literal strings, booleans, null, numbers, arrays, or objects."
  );
}

function objectLiteralToRecord(objectLiteral: ts.ObjectLiteralExpression): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error("Static Manifest objects may only contain property assignments.");
    }
    const key = propertyNameToString(property.name);
    if (key === null) {
      throw new Error("Static Manifest property names must be identifiers or string literals.");
    }
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`Static Manifest contains duplicate property "${key}".`);
    }
    record[key] = expressionToStaticValue(property.initializer);
  }
  return record;
}

function findExportedManifest(sourceFile: ts.SourceFile): ts.Expression | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const hasExport = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
    if (!hasExport) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "manifest") continue;
      return declaration.initializer ?? null;
    }
  }
  return null;
}

export function extractStaticManifestFromSource(
  source: string,
  fileName: string,
  now: number = Date.now()
): StaticManifestExtractionResult {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const parseDiagnostics = getParseDiagnostics(sourceFile);
  if (parseDiagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: parseDiagnostics.map((parseDiagnostic) =>
        diagnostic(
          "manifest.static.parse_error",
          ts.flattenDiagnosticMessageText(parseDiagnostic.messageText, "\n"),
          now
        )
      ),
    };
  }

  const initializer = findExportedManifest(sourceFile);
  if (initializer === null) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "manifest.static.missing",
          "extension.ts must export `const manifest = defineManifest({ ... })` or a static object literal.",
          now
        ),
      ],
    };
  }

  const objectLiteral = manifestInitializerToObjectLiteral(initializer);
  if (objectLiteral === null) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "manifest.static.unsupported",
          "Static Manifest export must be a literal object or defineManifest({...}) call.",
          now
        ),
      ],
    };
  }

  try {
    return { ok: true, manifest: objectLiteralToRecord(objectLiteral), diagnostics: [] };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "manifest.static.unsupported",
          error instanceof Error ? error.message : String(error),
          now
        ),
      ],
    };
  }
}

export async function extractStaticManifestFromFile(
  filePath: string,
  now: number = Date.now()
): Promise<StaticManifestExtractionResult> {
  let source: string;
  try {
    const handle = await fsPromises.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const sizeValidation = validateFileSize({
        size: stat.size,
        modifiedTime: stat.mtime,
        isDirectory: stat.isDirectory(),
      });
      if (sizeValidation) throw new Error(sizeValidation.error);
      source = await handle.readFile("utf-8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "extension.entrypoint.read_failed",
          `Failed to read extension.ts: ${error instanceof Error ? error.message : String(error)}`,
          now
        ),
      ],
    };
  }
  return extractStaticManifestFromSource(source, filePath, now);
}
