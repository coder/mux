/**
 * Shared parser for the `// description:` workflow header convention.
 *
 * Both the runtime workflow scanner (WorkflowDefinitionStore) and the built-in
 * workflow codegen (scripts/gen_builtin_workflows.ts) consume this so the
 * convention cannot drift between build time and runtime. Keep this module
 * dependency-free: the codegen script runs before
 * builtInWorkflowContent.generated.ts exists, so nothing here may transitively
 * import workflow definitions.
 */

export const WORKFLOW_DESCRIPTION_PREFIX = "// description:";

export function parseWorkflowDescription(source: string): string | null {
  const firstMeaningfulLine = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstMeaningfulLine?.startsWith(WORKFLOW_DESCRIPTION_PREFIX)) {
    return null;
  }

  const description = firstMeaningfulLine.slice(WORKFLOW_DESCRIPTION_PREFIX.length).trim();
  return description.length > 0 ? description : null;
}
