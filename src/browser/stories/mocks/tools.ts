import type {
  MuxTextPart,
  MuxReasoningPart,
  MuxFilePart,
  MuxToolPart,
} from "@/common/types/message";
import type {
  CodeExecutionResult,
  NestedToolCall,
} from "@/browser/features/Tools/Shared/codeExecutionTypes";
import type { TodoItem } from "@/common/types/tools";

/** Part type for message construction */
type MuxPart = MuxTextPart | MuxReasoningPart | MuxFilePart | MuxToolPart;

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL CALL FACTORY
// ═══════════════════════════════════════════════════════════════════════════════
export function createFileReadTool(toolCallId: string, filePath: string, content: string): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "file_read",
    state: "output-available",
    input: { path: filePath },
    output: { success: true, content },
  };
}

export function createFileEditTool(toolCallId: string, filePath: string, diff: string): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "file_edit_replace_string",
    state: "output-available",
    input: { path: filePath, old_string: "...", new_string: "..." },
    output: { success: true, diff, edits_applied: 1 },
  };
}

export function createBashOverflowTool(
  toolCallId: string,
  script: string,
  notice: string,
  truncated: { reason: string; totalLines: number },
  timeoutSecs = 3,
  durationMs = 50,
  displayName = "Bash"
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash",
    state: "output-available",
    input: {
      script,
      run_in_background: false,
      timeout_secs: timeoutSecs,
      display_name: displayName,
    },
    output: {
      success: true,
      output: "",
      note: notice,
      exitCode: 0,
      wall_duration_ms: durationMs,
      truncated,
    },
  };
}

export function createBashTool(
  toolCallId: string,
  script: string,
  output: string,
  exitCode = 0,
  timeoutSecs = 3,
  durationMs = 50,
  displayName = "Bash"
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash",
    state: "output-available",
    input: {
      script,
      run_in_background: false,
      timeout_secs: timeoutSecs,
      display_name: displayName,
    },
    output: { success: exitCode === 0, output, exitCode, wall_duration_ms: durationMs },
  };
}

export function createWebSearchTool(
  toolCallId: string,
  query: string,
  resultCount = 5,
  encrypted = true
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "web_search",
    state: "output-available",
    input: { query },
    output: encrypted
      ? Array.from({ length: resultCount }, () => ({ encryptedContent: "base64data..." }))
      : [{ title: "Example Result", url: "https://example.com", snippet: "A sample snippet" }],
  };
}

export function createTerminalTool(
  toolCallId: string,
  command: string,
  output: string,
  exitCode = 0
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "run_terminal_cmd",
    state: "output-available",
    input: { command, explanation: "Running command" },
    output: { success: exitCode === 0, stdout: output, exitCode },
  };
}

export function createTodoWriteTool(
  toolCallId: string,
  todosOrMessage: TodoItem[] | string,
  status: TodoItem["status"] = "in_progress"
): MuxPart {
  const todos =
    typeof todosOrMessage === "string" ? [{ content: todosOrMessage, status }] : todosOrMessage;

  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "todo_write",
    state: "output-available",
    input: { todos },
    output: { success: true, count: todos.length },
  };
}

export function createStatusTool(
  toolCallId: string,
  emoji: string,
  message: string,
  url?: string
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "status_set",
    state: "output-available",
    input: { emoji, message, url },
    output: { success: true, emoji, message, url },
  };
}

export function createPendingTool(toolCallId: string, toolName: string, args: object): MuxPart {
  // Note: "input-available" is used for in-progress tool calls that haven't completed yet
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName,
    state: "input-available",
    input: args,
  };
}

/** Create a generic tool call with custom name, args, and output - falls back to GenericToolCall */

/** Create an agent_skill_read tool call */
export function createAgentSkillReadTool(
  toolCallId: string,
  skillName: string,
  opts: {
    description?: string;
    scope?: "project" | "global" | "built-in";
    body?: string;
  } = {}
): MuxPart {
  const scope = opts.scope ?? "project";
  const description = opts.description ?? `${skillName} skill description`;
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "agent_skill_read",
    state: "output-available",
    input: { name: skillName },
    output: {
      success: true,
      skill: {
        scope,
        directoryName: skillName,
        frontmatter: {
          name: skillName,
          description,
        },
        body: opts.body ?? `# ${skillName}\n\nSkill content here.`,
      },
    },
  };
}

export function createGenericTool(
  toolCallId: string,
  toolName: string,
  input: object,
  output: object
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName,
    state: "output-available",
    input,
    output,
  };
}

/** Create a propose_plan tool call with markdown plan content */
export function createProposePlanTool(
  toolCallId: string,
  planContent: string,
  planPath = ".mux/plan.md"
): MuxPart {
  // Extract title from first heading
  const titleMatch = /^#\s+(.+)$/m.exec(planContent);
  const title = titleMatch ? titleMatch[1] : "Plan";

  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "propose_plan",
    state: "output-available",
    input: { title, plan: planContent },
    output: {
      success: true,
      planPath,
      planContent, // Include for story rendering
      message: `Plan saved to ${planPath}`,
    },
  };
}

/**
 * Add hook_output to a tool part's output.
 * Use this to simulate a tool hook that ran and produced output.
 * Only works on tool parts with state="output-available".
 */
export function withHookOutput(
  toolPart: MuxPart,
  hookOutput: string,
  hookDurationMs?: number
): MuxPart {
  if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
    return toolPart;
  }
  const existingOutput = toolPart.output;
  return {
    ...toolPart,
    output: {
      ...(typeof existingOutput === "object" && existingOutput !== null
        ? existingOutput
        : { result: existingOutput }),
      hook_output: hookOutput,
      hook_duration_ms: hookDurationMs,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CODE EXECUTION (PTC) TOOL FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a code_execution tool call with nested tools */
export function createCodeExecutionTool(
  toolCallId: string,
  code: string,
  result: CodeExecutionResult,
  nestedCalls?: NestedToolCall[]
): MuxPart & { nestedCalls?: NestedToolCall[] } {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "code_execution",
    state: "output-available",
    input: { code },
    output: result,
    nestedCalls,
  };
}

/** Create a pending code_execution tool (executing state) */
export function createPendingCodeExecutionTool(
  toolCallId: string,
  code: string,
  nestedCalls?: NestedToolCall[]
): MuxPart & { nestedCalls?: NestedToolCall[] } {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "code_execution",
    state: "input-available",
    input: { code },
    nestedCalls,
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// BACKGROUND BASH TOOL FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a bash tool that spawns a background process */
export function createBackgroundBashTool(
  toolCallId: string,
  script: string,
  processId: string,
  displayName = "Background",
  timeoutSecs = 60
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash",
    state: "output-available",
    input: {
      script,
      run_in_background: true,
      display_name: displayName,
      timeout_secs: timeoutSecs,
    },
    output: {
      success: true,
      output: `Background process started with ID: ${processId}`,
      exitCode: 0,
      wall_duration_ms: 50,
      taskId: `bash:${processId}`,
      backgroundProcessId: processId,
    },
  };
}

/** Create a foreground bash that was migrated to background (user clicked "Background" button) */
export function createMigratedBashTool(
  toolCallId: string,
  script: string,
  processId: string,
  displayName = "Bash",
  capturedOutput?: string,
  timeoutSecs = 30
): MuxPart {
  const outputLines = capturedOutput?.split("\n") ?? [];
  const outputSummary =
    outputLines.length > 20
      ? `${outputLines.slice(-20).join("\n")}\n...(showing last 20 lines)`
      : (capturedOutput ?? "");
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash",
    state: "output-available",
    // No run_in_background flag - this started as foreground
    input: {
      script,
      run_in_background: false,
      display_name: displayName,
      timeout_secs: timeoutSecs,
    },
    output: {
      success: true,
      output: `Process sent to background with ID: ${processId}\n\nOutput so far (${outputLines.length} lines):\n${outputSummary}`,
      exitCode: 0,
      wall_duration_ms: 5000,
      taskId: `bash:${processId}`,
      backgroundProcessId: processId, // This triggers the "backgrounded" status
    },
  };
}

/** Create a bash_output tool call showing process output */
export function createBashOutputTool(
  toolCallId: string,
  processId: string,
  output: string,
  status: "running" | "exited" | "killed" | "failed" = "running",
  exitCode?: number,
  filter?: string,
  timeoutSecs = 5,
  filterExclude?: boolean
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash_output",
    state: "output-available",
    input: {
      process_id: processId,
      timeout_secs: timeoutSecs,
      filter,
      filter_exclude: filterExclude,
    },
    output: { success: true, status, output, exitCode },
  };
}

/** Create a bash_output tool call with error */
export function createBashOutputErrorTool(
  toolCallId: string,
  processId: string,
  error: string,
  timeoutSecs = 5
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash_output",
    state: "output-available",
    input: { process_id: processId, timeout_secs: timeoutSecs },
    output: { success: false, error },
  };
}

/** Create a bash_background_list tool call */
export function createBashBackgroundListTool(
  toolCallId: string,
  processes: Array<{
    process_id: string;
    status: "running" | "exited" | "killed" | "failed";
    script: string;
    uptime_ms: number;
    exitCode?: number;
    display_name?: string;
  }>
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash_background_list",
    state: "output-available",
    input: {},
    output: { success: true, processes },
  };
}

/** Create a bash_background_terminate tool call */
export function createBashBackgroundTerminateTool(
  toolCallId: string,
  processId: string,
  displayName?: string
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash_background_terminate",
    state: "output-available",
    input: { process_id: processId },
    output: {
      success: true,
      message: `Process ${processId} terminated`,
      display_name: displayName,
    },
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// TASK TOOL FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a task tool call (spawn sub-agent) - background/queued */
export function createTaskTool(
  toolCallId: string,
  opts: {
    subagent_type: "explore" | "exec";
    prompt: string;
    title: string;
    run_in_background?: boolean;
    taskId: string;
    status: "queued" | "running";
  }
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "task",
    state: "output-available",
    input: {
      subagent_type: opts.subagent_type,
      prompt: opts.prompt,
      title: opts.title,
      run_in_background: opts.run_in_background ?? false,
    },
    output: {
      status: opts.status,
      taskId: opts.taskId,
    },
  };
}

/** Create a completed task tool call with report */
export function createCompletedTaskTool(
  toolCallId: string,
  opts: {
    subagent_type: "explore" | "exec";
    prompt: string;
    title: string;
    taskId?: string;
    reportMarkdown: string;
    reportTitle?: string;
  }
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "task",
    state: "output-available",
    input: {
      subagent_type: opts.subagent_type,
      prompt: opts.prompt,
      title: opts.title,
      run_in_background: false,
    },
    output: {
      status: "completed",
      taskId: opts.taskId,
      reportMarkdown: opts.reportMarkdown,
      title: opts.reportTitle,
    },
  };
}

/** Create a pending task tool call (executing) */
export function createPendingTaskTool(
  toolCallId: string,
  opts: {
    subagent_type: "explore" | "exec";
    prompt: string;
    title: string;
    run_in_background?: boolean;
  }
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "task",
    state: "input-available",
    input: {
      subagent_type: opts.subagent_type,
      prompt: opts.prompt,
      title: opts.title,
      run_in_background: opts.run_in_background ?? false,
    },
  };
}

/** Create a failed task tool call (e.g., invalid agentId) */
export function createFailedTaskTool(
  toolCallId: string,
  opts: {
    subagent_type: string; // Allow invalid values for error testing
    prompt: string;
    title: string;
    run_in_background?: boolean;
    error: string;
  }
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "task",
    state: "output-available",
    input: {
      subagent_type: opts.subagent_type,
      prompt: opts.prompt,
      title: opts.title,
      run_in_background: opts.run_in_background ?? false,
    },
    output: {
      success: false,
      error: opts.error,
    },
  };
}

/** Create a task_apply_git_patch tool call */
export function createTaskApplyGitPatchTool(
  toolCallId: string,
  opts: {
    task_id: string;
    dry_run?: boolean;
    three_way?: boolean;
    force?: boolean;
    output:
      | {
          success: true;
          appliedCommits: Array<{ subject: string; sha?: string }>;
          headCommitSha?: string;
          dryRun?: boolean;
          note?: string;
        }
      | {
          success: false;
          error: string;
          note?: string;
        };
  }
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "task_apply_git_patch",
    state: "output-available",
    input: {
      task_id: opts.task_id,
      dry_run: opts.dry_run,
      three_way: opts.three_way,
      force: opts.force,
    },
    output: opts.output.success
      ? {
          success: true,
          taskId: opts.task_id,
          appliedCommits: opts.output.appliedCommits,
          headCommitSha: opts.output.headCommitSha,
          dryRun: opts.output.dryRun,
          note: opts.output.note,
        }
      : {
          success: false,
          taskId: opts.task_id,
          error: opts.output.error,
          note: opts.output.note,
        },
  };
}

/** Create a task_await tool call */
export function createTaskAwaitTool(
  toolCallId: string,
  opts: {
    task_ids?: string[];
    timeout_secs?: number;
    results: Array<{
      taskId: string;
      status: "completed" | "queued" | "running" | "awaiting_report" | "not_found" | "error";
      reportMarkdown?: string;
      title?: string;
      error?: string;
      note?: string;
    }>;
  }
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "task_await",
    state: "output-available",
    input: {
      task_ids: opts.task_ids,
      timeout_secs: opts.timeout_secs,
    },
    output: {
      results: opts.results.map((r) => {
        if (r.status === "completed") {
          return {
            status: "completed" as const,
            taskId: r.taskId,
            reportMarkdown: r.reportMarkdown ?? "",
            title: r.title,
            note: r.note,
          };
        }
        if (r.status === "error") {
          return {
            status: "error" as const,
            taskId: r.taskId,
            error: r.error ?? "Unknown error",
          };
        }
        if (r.status === "queued" || r.status === "running" || r.status === "awaiting_report") {
          return {
            status: r.status,
            taskId: r.taskId,
            note: r.note,
          };
        }
        return {
          status: r.status,
          taskId: r.taskId,
        };
      }),
    },
  };
}

/** Create a task_list tool call */
export function createTaskListTool(
  toolCallId: string,
  opts: {
    statuses?: Array<"queued" | "running" | "awaiting_report" | "reported">;
    tasks: Array<{
      taskId: string;
      status: "queued" | "running" | "awaiting_report" | "reported";
      parentWorkspaceId: string;
      agentType?: string;
      title?: string;
      depth: number;
    }>;
  }
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "task_list",
    state: "output-available",
    input: { statuses: opts.statuses },
    output: { tasks: opts.tasks },
  };
}

/** Create a task_terminate tool call */
export function createTaskTerminateTool(
  toolCallId: string,
  opts: {
    task_ids: string[];
    results: Array<{
      taskId: string;
      status: "terminated" | "not_found" | "invalid_scope" | "error";
      terminatedTaskIds?: string[];
      error?: string;
    }>;
  }
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "task_terminate",
    state: "output-available",
    input: { task_ids: opts.task_ids },
    output: {
      results: opts.results.map((r) => {
        if (r.status === "terminated") {
          return {
            status: "terminated" as const,
            taskId: r.taskId,
            terminatedTaskIds: r.terminatedTaskIds ?? [r.taskId],
          };
        }
        if (r.status === "error") {
          return {
            status: "error" as const,
            taskId: r.taskId,
            error: r.error ?? "Unknown error",
          };
        }
        return {
          status: r.status,
          taskId: r.taskId,
        };
      }),
    },
  };
}
