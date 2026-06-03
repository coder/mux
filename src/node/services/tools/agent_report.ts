import { jsonSchema, tool } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";

import { getErrorMessage } from "@/common/utils/errors";
import {
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
  type JsonSchemaValidationError,
} from "@/common/utils/jsonSchemaSubset";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  AgentReportFileToolArgsSchema,
  AgentReportInlineToolArgsSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { RuntimeError } from "@/node/runtime/Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";

import { validateFileSize, validatePathInCwd } from "./fileCommon";
import { requireTaskService, requireWorkspaceId } from "./toolUtils";

const DEFAULT_REPORT_MARKDOWN_PATH = "report.md";
const DEFAULT_STRUCTURED_OUTPUT_PATH = "structured-output.json";

const REPORT_MARKDOWN_MAX_BYTES = 256 * 1024;
const STRUCTURED_OUTPUT_MAX_BYTES = 64 * 1024;

interface AgentReportSuccessResult {
  success: true;
  message: string;
  report?: {
    reportMarkdown: string;
    title?: string;
    structuredOutput?: unknown;
  };
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

function validateStructuredOutput(config: ToolConfiguration, structuredOutput: unknown) {
  if (config.workflowAgentOutputSchema == null) {
    return null;
  }

  const validation = validateJsonSchemaSubset(config.workflowAgentOutputSchema, structuredOutput);
  return validation.success
    ? null
    : validationFailure("Structured output failed schema validation.", validation.errors);
}

function buildInlineInputSchema(config: ToolConfiguration) {
  const outputSchema = config.workflowAgentOutputSchema;
  if (outputSchema == null || !validateJsonSchemaSubsetSchema(outputSchema).success) {
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
        const parsed = AgentReportInlineToolArgsSchema.safeParse(value);
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

function buildFileInputSchema() {
  return jsonSchema(
    {
      type: "object",
      properties: {
        reportMarkdownPath: {
          anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
          description:
            "Optional path to the markdown report file. Pass null or omit to submit report.md from the workspace root.",
        },
        structuredOutputPath: {
          anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
          description:
            "Optional path to structured output JSON. Pass null or omit to submit structured-output.json when this task requires structured output.",
        },
        title: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["reportMarkdownPath", "structuredOutputPath", "title"],
      additionalProperties: false,
    } satisfies JSONSchema7,
    {
      validate: (value) => {
        const parsed = AgentReportFileToolArgsSchema.safeParse(value ?? {});
        return parsed.success
          ? { success: true, value: parsed.data }
          : { success: false, error: parsed.error };
      },
    }
  );
}

function getAgentReportInputSchema(config: ToolConfiguration) {
  return config.subagentReportFiles ? buildFileInputSchema() : buildInlineInputSchema(config);
}

function getAgentReportDescription(config: ToolConfiguration): string {
  if (!config.subagentReportFiles) {
    return TOOL_DEFINITIONS.agent_report.description;
  }

  return (
    TOOL_DEFINITIONS.agent_report.description +
    "\n\nSubagent file-backed report mode is enabled for this task. " +
    "Write the final human-readable report to `report.md` in the workspace root. " +
    (config.workflowAgentOutputSchema != null
      ? "Write the required structured output as valid JSON to `structured-output.json`. "
      : "") +
    "Then call agent_report with reportMarkdownPath, structuredOutputPath, and title all set to null so Mux uses the default files. " +
    "Only pass non-null file path arguments if you intentionally used non-default filenames."
  );
}

async function readReportFile(params: {
  config: ToolConfiguration;
  filePath: string;
  fieldPath: string;
  maxBytes: number;
}): Promise<{ success: true; content: string } | AgentReportFailureResult> {
  const { config, filePath, fieldPath, maxBytes } = params;
  const pathValidation = validatePathInCwd(filePath, config.cwd, config.runtime, [
    config.runtimeTempDir,
  ]);
  if (pathValidation) {
    return validationFailure("Report file submission failed.", [
      { path: fieldPath, message: pathValidation.error },
    ]);
  }

  const resolvedPath = config.runtime.normalizePath(filePath, config.cwd);
  let fileStat;
  try {
    fileStat = await config.runtime.stat(resolvedPath);
  } catch (error) {
    const message = error instanceof RuntimeError ? error.message : getErrorMessage(error);
    return validationFailure("Report file submission failed.", [{ path: fieldPath, message }]);
  }

  if (fileStat.isDirectory) {
    return validationFailure("Report file submission failed.", [
      { path: fieldPath, message: `Path is a directory, not a file: ${resolvedPath}` },
    ]);
  }

  const sizeValidation = validateFileSize(fileStat);
  if (sizeValidation) {
    return validationFailure("Report file submission failed.", [
      { path: fieldPath, message: sizeValidation.error },
    ]);
  }
  if (fileStat.size > maxBytes) {
    return validationFailure("Report file submission failed.", [
      {
        path: fieldPath,
        message: `File is too large (${fileStat.size} bytes). Maximum allowed is ${maxBytes} bytes.`,
      },
    ]);
  }

  try {
    const content = await readFileString(config.runtime, resolvedPath);
    if (Buffer.byteLength(content, "utf-8") > maxBytes) {
      return validationFailure("Report file submission failed.", [
        {
          path: fieldPath,
          message: `File is too large after decoding. Maximum allowed is ${maxBytes} bytes.`,
        },
      ]);
    }
    return { success: true, content };
  } catch (error) {
    const message = error instanceof RuntimeError ? error.message : getErrorMessage(error);
    return validationFailure("Report file submission failed.", [{ path: fieldPath, message }]);
  }
}

async function executeFileBackedReport(
  config: ToolConfiguration,
  rawArgs: unknown
): Promise<AgentReportResult> {
  const parsed = AgentReportFileToolArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return zodValidationFailure("Report file arguments failed validation.", parsed.error);
  }

  const reportMarkdownPath = parsed.data.reportMarkdownPath ?? DEFAULT_REPORT_MARKDOWN_PATH;
  const structuredOutputPath =
    parsed.data.structuredOutputPath ??
    (config.workflowAgentOutputSchema != null ? DEFAULT_STRUCTURED_OUTPUT_PATH : undefined);

  const markdown = await readReportFile({
    config,
    filePath: reportMarkdownPath,
    fieldPath: "$.reportMarkdownPath",
    maxBytes: REPORT_MARKDOWN_MAX_BYTES,
  });
  if (!markdown.success) {
    return markdown;
  }
  if (markdown.content.trim().length === 0) {
    return validationFailure("Report file submission failed.", [
      { path: "$.reportMarkdownPath", message: "Report markdown must not be empty" },
    ]);
  }

  let structuredOutput: unknown;
  if (structuredOutputPath != null) {
    const structuredOutputFile = await readReportFile({
      config,
      filePath: structuredOutputPath,
      fieldPath: "$.structuredOutputPath",
      maxBytes: STRUCTURED_OUTPUT_MAX_BYTES,
    });
    if (!structuredOutputFile.success) {
      return structuredOutputFile;
    }
    try {
      structuredOutput = JSON.parse(structuredOutputFile.content) as unknown;
    } catch (error) {
      return validationFailure("Structured output JSON failed parsing.", [
        { path: "$.structuredOutputPath", message: getErrorMessage(error) },
      ]);
    }
  } else if (config.workflowAgentOutputSchema != null) {
    return validationFailure("Structured output file is required.", [
      { path: "$.structuredOutputPath", message: "Required property is missing" },
    ]);
  }

  const structuredValidation = validateStructuredOutput(config, structuredOutput);
  if (structuredValidation) {
    return structuredValidation;
  }

  const title = parsed.data.title?.trim();
  return {
    success: true,
    message: "Report submitted successfully.",
    report: {
      reportMarkdown: markdown.content,
      ...(title ? { title } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    },
  };
}

function executeInlineReport(config: ToolConfiguration, rawArgs: unknown): AgentReportResult {
  const parsed = AgentReportInlineToolArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return zodValidationFailure("Report arguments failed validation.", parsed.error);
  }

  const structuredValidation = validateStructuredOutput(config, parsed.data.structuredOutput);
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
    description: getAgentReportDescription(config),
    inputSchema: getAgentReportInputSchema(config),
    execute: async (args: unknown): Promise<AgentReportResult> => {
      const workspaceId = requireWorkspaceId(config, "agent_report");
      const taskService = requireTaskService(config, "agent_report");

      if (taskService.hasActiveDescendantAgentTasksForWorkspace(workspaceId)) {
        throw new Error(
          "agent_report rejected: this task still has running/queued descendant tasks. " +
            "Call task_await (or wait for tasks to finish) before reporting."
        );
      }

      if (config.subagentReportFiles) {
        return await executeFileBackedReport(config, args);
      }

      return executeInlineReport(config, args);
    },
  });
};
