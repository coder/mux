import type { WorkflowName } from "@/common/types/workflow";
import { BUILTIN_WORKFLOW_CONTENT } from "./builtInWorkflowContent.generated";

export interface BuiltInWorkflowDefinition {
  name: WorkflowName;
  description: string;
  source: string;
}

// Built-in workflow definitions are authored as real JavaScript files in
// src/node/builtinWorkflows/ and embedded at build time by
// scripts/gen_builtin_workflows.ts so the QuickJS sandbox can evaluate them
// as plain source strings.
export const BUILT_IN_WORKFLOW_DEFINITIONS: readonly BuiltInWorkflowDefinition[] =
  BUILTIN_WORKFLOW_CONTENT;
