import { jsonSchema, tool } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";

import {
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
  type JsonSchemaValidationError,
} from "@/common/utils/jsonSchemaSubset";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  AgentReportInlineToolArgsSchema,
  AgentReportWorkflowInlineToolArgsSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

import { requireTaskService, requireWorkspaceId } from "./toolUtils";

interface AgentReportSuccessResult {
  success: true;
  message: string;
}

interface AgentReportFailureResult {
  success: false;
  message: string;
  errors: JsonSchemaValidationError[];
}

type AgentReportResult = AgentReportSuccessResult | AgentReportFailureResult;

function validationFailure(
  message: string,
  errors: JsonSchemaValidationError[]
): AgentReportFailureResult {
  return { success: false, message, errors };
}

function zodValidationFailure(
  message: string,
  error: { issues: Array<{ path: unknown[]; message: string }> }
) {
  return validationFailure(
    message,
    error.issues.map((issue) => ({
      path: issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$",
      message: issue.message,
    }))
  );
}

function getWorkflowAgentOutputSchema(
  config: ToolConfiguration
): Record<string, unknown> | undefined {
  const outputSchema = config.workflowAgentOutputSchema;
  if (outputSchema == null) {
    return undefined;
  }
  const schemaValidation = validateJsonSchemaSubsetSchema(outputSchema);
  if (schemaValidation.success) {
    return outputSchema as Record<string, unknown>;
  }
  if (config.allowLegacyInvalidWorkflowAgentOutputSchema === true) {
    return undefined;
  }
  throw new Error("Invalid workflow agent output schema for agent_report.");
}

function validateStructuredOutput(config: ToolConfiguration, structuredOutput: unknown) {
  const outputSchema = getWorkflowAgentOutputSchema(config);
  if (outputSchema == null) {
    return null;
  }

  const validation = validateJsonSchemaSubset(outputSchema, structuredOutput);
  return validation.success
    ? null
    : validationFailure("Structured output failed schema validation.", validation.errors);
}

function buildInlineInputSchema(config: ToolConfiguration) {
  const outputSchema = getWorkflowAgentOutputSchema(config);
  if (outputSchema == null) {
    return AgentReportInlineToolArgsSchema;
  }

  return jsonSchema(
    {
      type: "object",
      properties: {
        reportMarkdown: { type: "string", minLength: 1 },
        structuredOutput: outputSchema as JSONSchema7,
        title: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["reportMarkdown", "structuredOutput", "title"],
      additionalProperties: false,
    } satisfies JSONSchema7,
    {
      validate: (value) => {
        const parsed = AgentReportWorkflowInlineToolArgsSchema.safeParse(value);
        if (!parsed.success) {
          return { success: false, error: parsed.error };
        }
        const validation = validateStructuredOutput(config, parsed.data.structuredOutput);
        if (validation) {
          return { success: false, error: new Error(validation.message) };
        }
        return { success: true, value: parsed.data };
      },
    }
  );
}

function executeInlineReport(config: ToolConfiguration, rawArgs: unknown): AgentReportResult {
  const argsSchema =
    getWorkflowAgentOutputSchema(config) == null
      ? AgentReportInlineToolArgsSchema
      : AgentReportWorkflowInlineToolArgsSchema;
  const parsed = argsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return zodValidationFailure("Report arguments failed validation.", parsed.error);
  }

  const structuredOutput =
    "structuredOutput" in parsed.data ? parsed.data.structuredOutput : undefined;
  const structuredValidation = validateStructuredOutput(config, structuredOutput);
  if (structuredValidation) {
    return structuredValidation;
  }

  // Intentionally no report payload on success. The backend orchestrator consumes inline
  // tool-call args from persisted history once the tool call completes successfully.
  return {
    success: true,
    message: "Report submitted successfully.",
  };
}

export const createAgentReportTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_report.description,
    inputSchema: buildInlineInputSchema(config),
    execute: (args: unknown): AgentReportResult => {
      const workspaceId = requireWorkspaceId(config, "agent_report");
      const taskService = requireTaskService(config, "agent_report");

      if (taskService.hasActiveDescendantAgentTasksForWorkspace(workspaceId)) {
        throw new Error(
          "agent_report rejected: this task still has running/queued descendant tasks. " +
            "Call task_await (or wait for tasks to finish) before reporting."
        );
      }

      return executeInlineReport(config, args);
    },
  });
};
