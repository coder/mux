import type { Plugin } from "vite";

const NOVNC_LIB_MARKER = "/node_modules/@novnc/novnc/lib/";
const EXPORT_ASSIGNMENT_PATTERN = /exports(?:\.(\w+)|\["([^"]+)"\])\s*=\s*/g;
const REQUIRE_WILDCARD_PATTERN =
  /var\s+(\w+)\s*=\s*_interopRequireWildcard\(require\(["']([^"']+)["']\)\);?/g;
const REQUIRE_DEFAULT_PATTERN =
  /var\s+(\w+)\s*=\s*_interopRequireDefault\(require\(["']([^"']+)["']\)\);?/g;
const REQUIRE_PATTERN = /var\s+(\w+)\s*=\s*require\(["']([^"']+)["']\);?/g;
const ES_MODULE_MARKER_PATTERN =
  /Object\.defineProperty\(exports,\s*"__esModule",\s*\{[\s\S]*?\}\);?\s*/g;

type ExportBindingMap = Map<string, string>;

const LOCAL_BINDING_NAME_PATTERN = /^[A-Za-z_$][\w$]*$/;
const RESERVED_BINDING_NAMES = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function getExportName(
  dotName: string | undefined,
  bracketName: string | undefined
): string | null {
  const exportName = dotName ?? bracketName;
  if (!exportName || exportName === "__esModule") {
    return null;
  }

  return exportName;
}

// Babel's CJS output often seeds exports with placeholders like `exports.foo = void 0`
// or `exports.bar = false` before the real local binding exists. Those literals are
// not valid ESM export specifiers, so only declared identifier-like bindings should
// participate in the generated `export { ... }` list.
function isValidLocalBindingName(localName: string): boolean {
  return LOCAL_BINDING_NAME_PATTERN.test(localName) && !RESERVED_BINDING_NAMES.has(localName);
}

function collectLocalBindings(code: string): Set<string> {
  const bindings = new Set<string>();

  for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    bindings.add(match[1]);
  }

  for (const match of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\b/g)) {
    bindings.add(match[1]);
  }

  for (const declaration of code.matchAll(/\b(?:var|let|const)\s+([\s\S]*?);/g)) {
    for (const binding of declaration[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?==|,|$)/g)) {
      bindings.add(binding[1]);
    }
  }

  return bindings;
}

function collectExportBindings(code: string): {
  defaultBinding: string | null;
  namedBindings: ExportBindingMap;
} {
  const localBindings = collectLocalBindings(code);
  const namedBindings: ExportBindingMap = new Map();
  let defaultBinding: string | null = null;

  function recordBinding(exportName: string | null, localName: string): void {
    if (!exportName || !isValidLocalBindingName(localName) || !localBindings.has(localName)) {
      return;
    }

    if (exportName === "default") {
      defaultBinding = localName;
      return;
    }

    namedBindings.set(exportName, localName);
  }

  for (const match of code.matchAll(/var\s+(\w+)\s*=\s*exports(?:\.(\w+)|\["([^"]+)"\])\s*=/g)) {
    recordBinding(getExportName(match[2], match[3]), match[1]);
  }

  for (const match of code.matchAll(/exports(?:\.(\w+)|\["([^"]+)"\])\s*=\s*(\w+)\s*=/g)) {
    recordBinding(getExportName(match[1], match[2]), match[3]);
  }

  for (const match of code.matchAll(/exports(?:\.(\w+)|\["([^"]+)"\])\s*=\s*(\w+)\s*;/g)) {
    recordBinding(getExportName(match[1], match[2]), match[3]);
  }

  for (const match of code.matchAll(/exports(?:\.(\w+)|\["([^"]+)"\])/g)) {
    const exportName = getExportName(match[1], match[2]);
    if (
      !exportName ||
      exportName === "default" ||
      namedBindings.has(exportName) ||
      !localBindings.has(exportName)
    ) {
      continue;
    }

    namedBindings.set(exportName, exportName);
  }

  return { defaultBinding, namedBindings };
}

/**
 * Vite plugin that transforms @novnc/novnc CJS (Babel-compiled) files to ESM
 * for both dev and production builds. noVNC publishes only CJS in lib/, but
 * uses top-level await in some files, which breaks both esbuild pre-bundling
 * and Rollup's CommonJS parsing. This plugin rewrites require()/exports to
 * import/export so both Vite and Rollup see valid ESM.
 */
export function novncCompatPlugin(): Plugin {
  return {
    name: "novnc-compat",
    enforce: "pre",

    transform(code: string, id: string) {
      const [cleanId] = id.split("?");
      if (!cleanId.includes(NOVNC_LIB_MARKER) || !cleanId.endsWith(".js")) {
        return null;
      }

      const { defaultBinding, namedBindings } = collectExportBindings(code);
      let result = code;

      // ESM modules are already strict, so the CJS prologue is redundant noise.
      result = result.replace(/^"use strict";\s*/m, "");
      result = result.replace(ES_MODULE_MARKER_PATTERN, "");
      result = result.replace(REQUIRE_WILDCARD_PATTERN, 'import * as $1 from "$2";');
      result = result.replace(REQUIRE_DEFAULT_PATTERN, 'import * as $1 from "$2";');
      result = result.replace(REQUIRE_PATTERN, 'import * as $1 from "$2";');
      result = result.replace(EXPORT_ASSIGNMENT_PATTERN, "");
      result = result.replace(/^\s*void 0;\s*$/gm, "");

      const exportLines: string[] = [];
      if (namedBindings.size > 0) {
        const namedSpecifiers = [...namedBindings.entries()].map(([exportName, localName]) =>
          exportName === localName ? exportName : `${localName} as ${exportName}`
        );
        exportLines.push(`export { ${namedSpecifiers.join(", ")} };`);
      }
      if (defaultBinding) {
        exportLines.push(`export { ${defaultBinding} as default };`);
      }

      result = `${result.trimEnd()}\n${exportLines.map((line) => `\n${line}`).join("")}\n`;

      if (/(?:^|[^\w$.])require\(/m.test(result) || /exports(?:\.|\[)/.test(result)) {
        throw new Error(`novnc-compat: failed to fully convert ${cleanId} to ESM`);
      }

      return {
        code: result,
        map: null,
      };
    },
  };
}
