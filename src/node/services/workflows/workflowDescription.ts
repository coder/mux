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

const WORKFLOW_DESCRIPTION_LITERAL_PATTERN =
  /((^|[;\n])\s*export\s+(?:const|let|var)\s+metadata\s*=\s*\{[\s\S]*?\bdescription\s*:\s*)(["'])((?:\\.|(?!\3)[\s\S])*)\3/su;

export function parseWorkflowDescription(source: string): string | null {
  const match = WORKFLOW_DESCRIPTION_LITERAL_PATTERN.exec(source);
  const description = match?.[4]?.trim();
  return description ? unescapeDescription(description) : null;
}

export function replaceWorkflowDescription(source: string, description: string): string | null {
  if (!WORKFLOW_DESCRIPTION_LITERAL_PATTERN.test(source)) {
    return null;
  }
  return source.replace(WORKFLOW_DESCRIPTION_LITERAL_PATTERN, (_match, prefix: string) => {
    return `${prefix}${JSON.stringify(description)}`;
  });
}

function unescapeDescription(value: string): string {
  return value.replace(/\\([\\"'])/gu, "$1");
}
