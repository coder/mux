/**
 * Shared parser for workflow `export const metadata = { description: "..." }` declarations.
 *
 * Both the runtime workflow scanner (WorkflowDefinitionStore) and the built-in
 * workflow codegen (scripts/gen_builtin_workflows.ts) consume this so the
 * convention cannot drift between build time and runtime. Keep this module
 * dependency-free: the codegen script runs before
 * builtInWorkflowContent.generated.ts exists, so nothing here may transitively
 * import workflow definitions.
 */

export function parseWorkflowDescription(source: string): string | null {
  const match =
    /(^|[;\n])\s*export\s+(?:const|let|var)\s+metadata\s*=\s*\{[\s\S]*?\bdescription\s*:\s*(["'])(.*?)\2/su.exec(
      source
    );
  const description = match?.[3]?.trim();
  return description ? unescapeDescription(description) : null;
}

function unescapeDescription(value: string): string {
  return value.replace(/\\([\\"'])/gu, "$1");
}
