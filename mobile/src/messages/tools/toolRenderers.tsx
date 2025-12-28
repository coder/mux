import type { ReactNode } from "react";
import React from "react";
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native";
import { Link } from "expo-router";
import { parsePatch } from "diff";
import {
  coerceBashToolResult,
  convertTaskBashResult,
} from "@/common/utils/tools/taskResultConverters";
import { isTaskBashArgs, isTaskBashArgsFromUnknown } from "@/common/utils/tools/taskToolTypeGuards";
import { resolveBashDisplayName } from "@/common/utils/tools/bashDisplayName";
import type { DisplayedMessage } from "@/common/types/message";
import {
  FILE_EDIT_TOOL_NAMES,
  type BashToolArgs,
  type BashToolResult,
  type BashOutputToolArgs,
  type BashOutputToolResult,
  type BashBackgroundListArgs,
  type BashBackgroundListResult,
  type BashBackgroundTerminateArgs,
  type BashBackgroundTerminateResult,
  type WebFetchToolArgs,
  type WebFetchToolResult,
  type FileEditInsertToolArgs,
  type FileEditInsertToolResult,
  type FileEditReplaceLinesToolArgs,
  type FileEditReplaceLinesToolResult,
  type FileEditReplaceStringToolArgs,
  type FileEditReplaceStringToolResult,
  type FileEditToolName,
  type FileReadToolArgs,
  type FileReadToolResult,
  type TaskToolArgs,
  type TaskToolResult,
  type TaskAwaitToolArgs,
  type TaskAwaitToolResult,
  type TaskListToolArgs,
  type TaskListToolResult,
  type TaskTerminateToolArgs,
  type TaskTerminateToolResult,
  type AgentReportToolArgs,
  type AgentReportToolResult,
} from "@/common/types/tools";
import { useTheme } from "../../theme";
import { MarkdownMessageBody } from "../../components/MarkdownMessageBody";
import { useLiveBashOutputView } from "../../contexts/LiveBashOutputContext";
import { ThemedText } from "../../components/ThemedText";

export type ToolDisplayedMessage = DisplayedMessage & { type: "tool" };

export interface ToolCardViewModel {
  icon: string;
  caption: string;
  title: string;
  subtitle?: string;
  summary?: ReactNode;
  content?: ReactNode;
  defaultExpanded?: boolean;
}

export function renderSpecializedToolCard(message: ToolDisplayedMessage): ToolCardViewModel | null {
  switch (message.toolName) {
    case "bash":
      if (!isBashToolArgs(message.args)) {
        return null;
      }
      return buildBashViewModel(message as ToolDisplayedMessage & { args: BashToolArgs });
    case "file_read":
      if (!isFileReadToolArgs(message.args)) {
        return null;
      }
      return buildFileReadViewModel(message as ToolDisplayedMessage & { args: FileReadToolArgs });
    case "web_fetch":
      if (!isWebFetchToolArgs(message.args)) {
        return null;
      }
      return buildWebFetchViewModel(message as ToolDisplayedMessage & { args: WebFetchToolArgs });
    case "bash_output":
      if (!isBashOutputToolArgs(message.args)) {
        return null;
      }
      return buildBashOutputViewModel(
        message as ToolDisplayedMessage & { args: BashOutputToolArgs }
      );
    case "bash_background_list":
      if (!isBashBackgroundListArgs(message.args)) {
        return null;
      }
      return buildBashBackgroundListViewModel(
        message as ToolDisplayedMessage & { args: BashBackgroundListArgs }
      );
    case "task":
      if (!isTaskToolArgs(message.args)) {
        return null;
      }
      if (isTaskBashArgs(message.args)) {
        return buildTaskBashViewModel(message as ToolDisplayedMessage & { args: TaskToolArgs });
      }
      return buildTaskViewModel(message as ToolDisplayedMessage & { args: TaskToolArgs });
    case "task_await":
      if (!isTaskAwaitToolArgs(message.args)) {
        return null;
      }
      return buildTaskAwaitViewModel(message as ToolDisplayedMessage & { args: TaskAwaitToolArgs });
    case "task_list":
      if (!isTaskListToolArgs(message.args)) {
        return null;
      }
      return buildTaskListViewModel(message as ToolDisplayedMessage & { args: TaskListToolArgs });
    case "task_terminate":
      if (!isTaskTerminateToolArgs(message.args)) {
        return null;
      }
      return buildTaskTerminateViewModel(
        message as ToolDisplayedMessage & { args: TaskTerminateToolArgs }
      );
    case "agent_report":
      if (!isAgentReportToolArgs(message.args)) {
        return null;
      }
      return buildAgentReportViewModel(
        message as ToolDisplayedMessage & { args: AgentReportToolArgs }
      );
    case "bash_background_terminate":
      if (!isBashBackgroundTerminateArgs(message.args)) {
        return null;
      }
      return buildBashBackgroundTerminateViewModel(
        message as ToolDisplayedMessage & { args: BashBackgroundTerminateArgs }
      );
    default:
      if (!FILE_EDIT_TOOL_NAMES.includes(message.toolName as FileEditToolName)) {
        return null;
      }
      if (!isFileEditArgsUnion(message.args)) {
        return null;
      }
      return buildFileEditViewModel(message as ToolDisplayedMessage & { args: FileEditArgsUnion });
  }
}

interface MetadataItem {
  label: string;
  value: ReactNode;
  tone?: "default" | "warning" | "danger";
}

function buildBashViewModel(
  message: ToolDisplayedMessage & { args: BashToolArgs }
): ToolCardViewModel {
  const args = message.args;
  const result = coerceBashToolResult(message.result);
  const preview = truncate(args.script.trim().split("\n")[0], 80) || "bash";

  const metadata: MetadataItem[] = [];
  if (typeof args.timeout_secs === "number") {
    metadata.push({ label: "timeout", value: `${args.timeout_secs}s` });
  }
  if (result && result.exitCode !== undefined) {
    metadata.push({ label: "exit code", value: String(result.exitCode) });
  }
  if (result && "truncated" in result && result.truncated) {
    metadata.push({
      label: "truncated",
      value: result.truncated.reason,
      tone: "warning",
    });
  }

  return {
    icon: "💻",
    caption: "bash",
    title: preview,
    summary: metadata.length > 0 ? <MetadataList items={metadata} /> : undefined,
    content: (
      <BashToolContent
        args={args}
        result={result}
        status={message.status}
        toolCallId={message.toolCallId}
      />
    ),
    defaultExpanded: message.status !== "completed" || Boolean(result && result.success === false),
  };
}

function buildFileReadViewModel(
  message: ToolDisplayedMessage & { args: FileReadToolArgs }
): ToolCardViewModel {
  const args = message.args;
  const result = coerceFileReadToolResult(message.result);

  const metadata: MetadataItem[] = [];
  if (typeof args.offset === "number") {
    metadata.push({ label: "offset", value: `line ${args.offset}` });
  }
  if (typeof args.limit === "number") {
    metadata.push({ label: "limit", value: `${args.limit} lines` });
  }
  if (result && result.success) {
    metadata.push({ label: "read", value: `${result.lines_read} lines` });
    metadata.push({ label: "size", value: formatBytes(result.file_size) });
    metadata.push({
      label: "modified",
      value: new Date(result.modifiedTime).toLocaleString(),
    });
    if (result.warning) {
      metadata.push({ label: "warning", value: truncate(result.warning, 80), tone: "warning" });
    }
  }

  return {
    icon: "📖",
    caption: "file_read",
    title: args.filePath,
    summary: metadata.length > 0 ? <MetadataList items={metadata} /> : undefined,
    content: <FileReadContent result={result} />,
    defaultExpanded: message.status !== "completed" || Boolean(result && result.success === false),
  };
}

function buildWebFetchViewModel(
  message: ToolDisplayedMessage & { args: WebFetchToolArgs }
): ToolCardViewModel {
  const args = message.args;
  const result = coerceWebFetchToolResult(message.result);

  const metadata: MetadataItem[] = [];
  if (result) {
    if (result.success) {
      metadata.push({ label: "title", value: truncate(result.title, 80) });
      if (result.byline) {
        metadata.push({ label: "byline", value: truncate(result.byline, 80) });
      }
      metadata.push({ label: "length", value: `${result.length.toLocaleString()} chars` });
    } else {
      metadata.push({ label: "error", value: truncate(result.error, 80), tone: "danger" });
    }
  }

  return {
    icon: "🌐",
    caption: "web_fetch",
    title: truncate(args.url, 80),
    summary: metadata.length > 0 ? <MetadataList items={metadata} /> : undefined,
    content: <WebFetchContent args={args} result={result} status={message.status} />,
    defaultExpanded: message.status !== "completed" || Boolean(result && result.success === false),
  };
}

function WebFetchContent({
  args,
  result,
}: {
  args: WebFetchToolArgs;
  result: WebFetchToolResult | null;
  status: ToolDisplayedMessage["status"];
}): JSX.Element {
  if (!result) {
    return <ThemedText variant="muted">Fetching…</ThemedText>;
  }

  if (!result.success) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  return (
    <View style={{ gap: 12 }}>
      <CodeBlock label="title" text={result.title} />
      <CodeBlock label="url" text={result.url ?? args.url} />
      {result.byline ? <CodeBlock label="byline" text={result.byline} /> : null}
      <ScrollableCodeBlock label="content" text={result.content} maxHeight={260} />
    </View>
  );
}

function buildBashOutputViewModel(
  message: ToolDisplayedMessage & { args: BashOutputToolArgs }
): ToolCardViewModel {
  const args = message.args;
  const result = coerceBashOutputToolResult(message.result);

  const metadata: MetadataItem[] = [{ label: "process", value: truncate(args.process_id, 16) }];
  if (result && result.success) {
    metadata.push({ label: "status", value: result.status });
    if (typeof result.exitCode === "number") {
      metadata.push({ label: "exit", value: String(result.exitCode) });
    }
  }

  return {
    icon: "📥",
    caption: "bash_output",
    title: truncate(args.process_id, 48),
    summary: metadata.length > 0 ? <MetadataList items={metadata} /> : undefined,
    content: <BashOutputContent result={result} />,
    defaultExpanded: message.status !== "completed" || Boolean(result && result.success === false),
  };
}

function BashOutputContent({ result }: { result: BashOutputToolResult | null }): JSX.Element {
  if (!result) {
    return <ThemedText variant="muted">Reading output…</ThemedText>;
  }

  if (!result.success) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  return (
    <View style={{ gap: 12 }}>
      <ScrollableCodeBlock label="output" text={result.output} maxHeight={260} />
      <MetadataList
        items={[
          { label: "status", value: result.status },
          { label: "elapsed", value: `${result.elapsed_ms} ms` },
        ]}
      />
    </View>
  );
}

function buildBashBackgroundListViewModel(
  message: ToolDisplayedMessage & { args: BashBackgroundListArgs }
): ToolCardViewModel {
  const result = coerceBashBackgroundListResult(message.result);

  const count = result && result.success ? result.processes.length : undefined;

  return {
    icon: "🧵",
    caption: "bash_background_list",
    title: "Background processes",
    subtitle: typeof count === "number" ? `${count} running/known` : undefined,
    content: <BashBackgroundListContent result={result} />,
    defaultExpanded: message.status !== "completed" || Boolean(result && result.success === false),
  };
}

function BashBackgroundListContent({
  result,
}: {
  result: BashBackgroundListResult | null;
}): JSX.Element {
  if (!result) {
    return <ThemedText variant="muted">Listing processes…</ThemedText>;
  }

  if (!result.success) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  if (result.processes.length === 0) {
    return <ThemedText variant="muted">(No background processes)</ThemedText>;
  }

  return (
    <View style={{ gap: 12 }}>
      {result.processes.map((proc) => {
        const title = proc.display_name ? proc.display_name : truncate(proc.script.trim(), 48);
        return (
          <View key={proc.process_id} style={{ gap: 6 }}>
            <ThemedText weight="semibold">{title}</ThemedText>
            <MetadataList
              items={[
                { label: "id", value: truncate(proc.process_id, 16) },
                { label: "status", value: proc.status },
                { label: "uptime", value: `${Math.round(proc.uptime_ms / 1000)}s` },
                ...(typeof proc.exitCode === "number"
                  ? [{ label: "exit", value: String(proc.exitCode) }]
                  : []),
              ]}
            />
          </View>
        );
      })}
    </View>
  );
}

function buildBashBackgroundTerminateViewModel(
  message: ToolDisplayedMessage & { args: BashBackgroundTerminateArgs }
): ToolCardViewModel {
  const args = message.args;
  const result = coerceBashBackgroundTerminateResult(message.result);

  return {
    icon: "🛑",
    caption: "bash_background_terminate",
    title: truncate(args.process_id, 48),
    content: <BashBackgroundTerminateContent result={result} />,
    defaultExpanded: message.status !== "completed" || Boolean(result && result.success === false),
  };
}

function BashBackgroundTerminateContent({
  result,
}: {
  result: BashBackgroundTerminateResult | null;
}): JSX.Element {
  if (!result) {
    return <ThemedText variant="muted">Terminating…</ThemedText>;
  }

  if (!result.success) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  return <ThemedText>{result.message}</ThemedText>;
}

function buildTaskBashViewModel(
  message: ToolDisplayedMessage & { args: TaskToolArgs }
): ToolCardViewModel {
  const args = message.args;
  if (!isTaskBashArgs(args)) {
    return {
      icon: "💻",
      caption: "bash",
      title: "bash",
      content: <ThemedText variant="muted">Invalid bash task args</ThemedText>,
      defaultExpanded: true,
    };
  }

  const displayName = resolveBashDisplayName(args.script, args.display_name);

  const bashArgs: BashToolArgs = {
    script: args.script,
    timeout_secs: args.timeout_secs,
    run_in_background: Boolean(args.run_in_background),
    display_name: displayName,
  };

  const taskResult = coerceTaskToolResult(message.result);
  const bashResult = convertTaskBashResult(taskResult, { legacySuccessCheckInclErrorLine: true });

  const preview = truncate(args.script.trim().split("\n")[0], 80) || "bash";

  const metadata: MetadataItem[] = [];
  metadata.push({ label: "name", value: displayName });

  if (typeof args.timeout_secs === "number") {
    metadata.push({ label: "timeout", value: `${args.timeout_secs}s` });
  }
  if (bashResult && bashResult.exitCode !== undefined) {
    metadata.push({ label: "exit code", value: String(bashResult.exitCode) });
  }
  if (bashResult && "truncated" in bashResult && bashResult.truncated) {
    metadata.push({
      label: "truncated",
      value: bashResult.truncated.reason,
      tone: "warning",
    });
  }

  return {
    icon: "💻",
    caption: "bash",
    title: preview,
    summary: metadata.length > 0 ? <MetadataList items={metadata} /> : undefined,
    content: (
      <BashToolContent
        args={bashArgs}
        result={bashResult}
        status={message.status}
        toolCallId={message.toolCallId}
      />
    ),
    defaultExpanded:
      message.status !== "completed" || Boolean(bashResult && bashResult.success === false),
  };
}

function buildTaskViewModel(
  message: ToolDisplayedMessage & { args: TaskToolArgs }
): ToolCardViewModel {
  const args = message.args;
  const result = coerceTaskToolResult(message.result);

  const taskId =
    result && !("success" in result) && typeof (result as { taskId?: unknown }).taskId === "string"
      ? ((result as { taskId: string }).taskId ?? null)
      : null;

  const metadata: MetadataItem[] = [{ label: "agent", value: args.subagent_type }];
  if (args.run_in_background) {
    metadata.push({ label: "background", value: "true" });
  }
  if (taskId) {
    metadata.push({ label: "task", value: truncate(taskId, 16) });
  }
  if (result && !("success" in result)) {
    metadata.push({ label: "status", value: result.status });
  }

  return {
    icon: "🧵",
    caption: "task",
    title: args.title,
    subtitle: args.subagent_type,
    summary: metadata.length > 0 ? <MetadataList items={metadata} /> : undefined,
    content: <TaskToolContent args={args} result={result} status={message.status} />,
    defaultExpanded: message.status !== "completed" || Boolean(result && "success" in result),
  };
}

function TaskToolContent({
  args,
  result,
  status,
}: {
  args: TaskToolArgs;
  result: TaskToolResult | null;
  status: ToolDisplayedMessage["status"];
}): JSX.Element {
  const theme = useTheme();

  if (result && "success" in result) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  const taskId =
    result && !("success" in result) && typeof (result as { taskId?: unknown }).taskId === "string"
      ? (result as { taskId: string }).taskId
      : null;

  const reportMarkdown =
    result && !("success" in result) && result.status === "completed"
      ? result.reportMarkdown
      : null;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {taskId ? <WorkspaceLinkButton workspaceId={taskId} /> : null}
      <ScrollableCodeBlock label="prompt" text={args.prompt} maxHeight={220} />
      {reportMarkdown ? (
        <View style={{ gap: theme.spacing.xs }}>
          <ThemedText variant="caption" style={{ color: theme.colors.foregroundSecondary }}>
            report
          </ThemedText>
          <View
            style={{
              padding: theme.spacing.sm,
              borderRadius: theme.radii.sm,
              backgroundColor: theme.colors.surfaceSunken,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.colors.border,
            }}
          >
            <MarkdownMessageBody variant="assistant" content={reportMarkdown} />
          </View>
        </View>
      ) : status === "executing" ? (
        <ThemedText variant="muted">Task running…</ThemedText>
      ) : null}
    </View>
  );
}

function buildTaskAwaitViewModel(
  message: ToolDisplayedMessage & { args: TaskAwaitToolArgs }
): ToolCardViewModel {
  const args = message.args;
  const result = coerceTaskAwaitToolResult(message.result);

  const taskCount = Array.isArray(args.task_ids) ? args.task_ids.length : undefined;
  const title = taskCount ? `Awaiting ${taskCount} task(s)` : "Awaiting tasks";

  const metadata: MetadataItem[] = [];
  if (typeof args.timeout_secs === "number") {
    metadata.push({ label: "timeout", value: `${args.timeout_secs}s` });
  }

  return {
    icon: "⏳",
    caption: "task_await",
    title,
    summary: metadata.length > 0 ? <MetadataList items={metadata} /> : undefined,
    content: <TaskAwaitContent result={result} status={message.status} />,
    defaultExpanded: message.status !== "completed" || Boolean(result && "success" in result),
  };
}

function TaskAwaitContent({
  result,
  status,
}: {
  result: TaskAwaitToolResult | null;
  status: ToolDisplayedMessage["status"];
}): JSX.Element {
  const theme = useTheme();

  if (!result) {
    return <ThemedText variant="muted">Waiting…</ThemedText>;
  }

  if ("success" in result) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  const results = result.results;
  if (!Array.isArray(results) || results.length === 0) {
    return status === "executing" ? (
      <ThemedText variant="muted">Waiting…</ThemedText>
    ) : (
      <ThemedText variant="muted">No tasks</ThemedText>
    );
  }

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {results.map((entry) => (
        <TaskResultRow key={entry.taskId} taskId={entry.taskId} status={entry.status}>
          {entry.status === "completed" ? (
            <View style={{ marginTop: theme.spacing.xs }}>
              <MarkdownMessageBody variant="assistant" content={entry.reportMarkdown} />
            </View>
          ) : "error" in entry && typeof entry.error === "string" ? (
            <ThemedText variant="muted" style={{ color: theme.colors.error }}>
              {entry.error}
            </ThemedText>
          ) : null}
        </TaskResultRow>
      ))}
    </View>
  );
}

function buildTaskListViewModel(
  message: ToolDisplayedMessage & { args: TaskListToolArgs }
): ToolCardViewModel {
  const args = message.args;
  const result = coerceTaskListToolResult(message.result);

  const statuses = Array.isArray(args.statuses) ? args.statuses.join(", ") : null;

  return {
    icon: "📋",
    caption: "task_list",
    title: "Tasks",
    subtitle: statuses ? `filter: ${statuses}` : undefined,
    content: <TaskListContent result={result} status={message.status} />,
    defaultExpanded: message.status !== "completed" || Boolean(result && "success" in result),
  };
}

function TaskListContent({
  result,
  status,
}: {
  result: TaskListToolResult | null;
  status: ToolDisplayedMessage["status"];
}): JSX.Element {
  const theme = useTheme();

  if (!result) {
    return <ThemedText variant="muted">Loading…</ThemedText>;
  }

  if ("success" in result) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  const tasks = result.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return status === "executing" ? (
      <ThemedText variant="muted">Loading…</ThemedText>
    ) : (
      <ThemedText variant="muted">No tasks</ThemedText>
    );
  }

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {tasks.map((task) => (
        <TaskResultRow key={task.taskId} taskId={task.taskId} status={task.status}>
          {task.title ? (
            <ThemedText variant="caption" style={{ color: theme.colors.foregroundSecondary }}>
              {task.title}
            </ThemedText>
          ) : null}
        </TaskResultRow>
      ))}
    </View>
  );
}

function buildTaskTerminateViewModel(
  message: ToolDisplayedMessage & { args: TaskTerminateToolArgs }
): ToolCardViewModel {
  const args = message.args;
  const result = coerceTaskTerminateToolResult(message.result);

  return {
    icon: "🛑",
    caption: "task_terminate",
    title: `Terminate ${args.task_ids.length} task(s)`,
    content: <TaskTerminateContent result={result} status={message.status} />,
    defaultExpanded: message.status !== "completed" || Boolean(result && "success" in result),
  };
}

function TaskTerminateContent({
  result,
  status,
}: {
  result: TaskTerminateToolResult | null;
  status: ToolDisplayedMessage["status"];
}): JSX.Element {
  const theme = useTheme();

  if (!result) {
    return <ThemedText variant="muted">Terminating…</ThemedText>;
  }

  if ("success" in result) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  const results = result.results;
  if (!Array.isArray(results) || results.length === 0) {
    return status === "executing" ? (
      <ThemedText variant="muted">Terminating…</ThemedText>
    ) : (
      <ThemedText variant="muted">No results</ThemedText>
    );
  }

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {results.map((entry) => (
        <TaskResultRow key={entry.taskId} taskId={entry.taskId} status={entry.status}>
          {"error" in entry && typeof entry.error === "string" ? (
            <ThemedText variant="caption" style={{ color: theme.colors.error }}>
              {entry.error}
            </ThemedText>
          ) : null}
        </TaskResultRow>
      ))}
    </View>
  );
}

function buildAgentReportViewModel(
  message: ToolDisplayedMessage & { args: AgentReportToolArgs }
): ToolCardViewModel {
  const args = message.args;
  const result = coerceAgentReportToolResult(message.result);

  return {
    icon: "📝",
    caption: "agent_report",
    title: args.title ?? "Agent report",
    content: <AgentReportContent args={args} result={result} status={message.status} />,
    defaultExpanded: true,
  };
}

function AgentReportContent({
  args,
  result,
  status,
}: {
  args: AgentReportToolArgs;
  result: AgentReportToolResult | null;
  status: ToolDisplayedMessage["status"];
}): JSX.Element {
  const theme = useTheme();

  if (result && "success" in result && result.success === false) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  if (status === "executing") {
    return <ThemedText variant="muted">Reporting…</ThemedText>;
  }

  return (
    <View
      style={{
        padding: theme.spacing.sm,
        borderRadius: theme.radii.sm,
        backgroundColor: theme.colors.surfaceSunken,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
      }}
    >
      <MarkdownMessageBody variant="assistant" content={args.reportMarkdown} />
    </View>
  );
}

function TaskResultRow({
  taskId,
  status,
  children,
}: {
  taskId: string;
  status: string;
  children?: ReactNode;
}): JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={{
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surfaceSunken,
        borderRadius: theme.radii.sm,
        padding: theme.spacing.sm,
        gap: theme.spacing.xs,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
        <ThemedText variant="monoMuted" style={{ flex: 1 }} numberOfLines={1}>
          {taskId}
        </ThemedText>
        <ThemedText variant="caption" style={{ color: theme.colors.foregroundSecondary }}>
          {status}
        </ThemedText>
        <WorkspaceLinkButton workspaceId={taskId} label="Open" />
      </View>
      {children}
    </View>
  );
}

function WorkspaceLinkButton({
  workspaceId,
  label,
}: {
  workspaceId: string;
  label?: string;
}): JSX.Element {
  const theme = useTheme();

  return (
    <Link href={`/workspace/${encodeURIComponent(workspaceId)}`} asChild>
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => ({
          paddingHorizontal: theme.spacing.sm,
          paddingVertical: theme.spacing.xs,
          borderRadius: theme.radii.pill,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.accent,
          backgroundColor: theme.colors.accentMuted,
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <ThemedText variant="caption" style={{ color: theme.colors.accent }}>
          {label ?? "Open workspace"}
        </ThemedText>
      </Pressable>
    </Link>
  );
}

function ScrollableCodeBlock({
  label,
  text,
  tone,
  maxHeight,
}: {
  label: string;
  text: string;
  tone?: "default" | "warning" | "danger";
  maxHeight: number;
}): JSX.Element {
  const theme = useTheme();
  const palette = getCodeBlockPalette(theme, tone ?? "default");

  return (
    <View
      style={{
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: palette.border,
        backgroundColor: palette.background,
        borderRadius: theme.radii.sm,
        padding: theme.spacing.sm,
        gap: 6,
      }}
    >
      <ThemedText variant="caption" style={{ color: palette.label }}>
        {label}
      </ThemedText>
      <ScrollView style={{ maxHeight }} showsVerticalScrollIndicator>
        <Text
          style={{
            color: palette.textColor,
            fontFamily: theme.typography.familyMono,
            fontSize: 12,
          }}
        >
          {text.length === 0 ? "(empty)" : text}
        </Text>
      </ScrollView>
    </View>
  );
}

function buildFileEditViewModel(
  message: ToolDisplayedMessage & { args: FileEditArgsUnion }
): ToolCardViewModel {
  const toolName = message.toolName as FileEditToolName;
  const args = message.args;
  const result = coerceFileEditResultUnion(message.result);

  const metadata = buildFileEditMetadata(toolName, args, result);

  return {
    icon: "✏️",
    caption: toolName,
    title: args.file_path,
    summary: metadata.length > 0 ? <MetadataList items={metadata} /> : undefined,
    content: <FileEditContent toolName={toolName} args={args} result={result} />,
    defaultExpanded: true,
  };
}

function MetadataList({ items }: { items: MetadataItem[] }): JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: theme.spacing.xs,
      }}
    >
      {items.map((item, index) => (
        <MetadataPill key={`${item.label}-${index}`} item={item} />
      ))}
    </View>
  );
}

function MetadataPill({ item }: { item: MetadataItem }): JSX.Element {
  const theme = useTheme();
  const palette = getMetadataPalette(theme, item.tone ?? "default");
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xs,
        borderRadius: theme.radii.pill,
        backgroundColor: palette.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: palette.border,
      }}
    >
      <ThemedText variant="caption" style={{ color: palette.label }}>
        {item.label}
      </ThemedText>
      <Text
        style={{
          color: palette.textColor,
          fontSize: theme.typography.sizes.body,
          fontFamily: theme.typography.familyMono,
        }}
        numberOfLines={1}
      >
        {item.value}
      </Text>
    </View>
  );
}

function getMetadataPalette(
  theme: ReturnType<typeof useTheme>,
  tone: "default" | "warning" | "danger"
) {
  switch (tone) {
    case "warning":
      return {
        background: "rgba(255, 193, 7, 0.12)",
        border: "rgba(255, 193, 7, 0.32)",
        label: theme.colors.warning,
        textColor: theme.colors.foregroundPrimary,
      };
    case "danger":
      return {
        background: "rgba(244, 67, 54, 0.12)",
        border: "rgba(244, 67, 54, 0.32)",
        label: theme.colors.error,
        textColor: theme.colors.foregroundPrimary,
      };
    default:
      return {
        background: "rgba(255, 255, 255, 0.04)",
        border: "rgba(255, 255, 255, 0.08)",
        label: theme.colors.foregroundSecondary,
        textColor: theme.colors.foregroundPrimary,
      };
  }
}

function BashToolContent({
  args,
  result,
  status,
  toolCallId,
}: {
  args: BashToolArgs;
  result: BashToolResult | null;
  status: ToolDisplayedMessage["status"];
  toolCallId: string;
}): JSX.Element {
  const theme = useTheme();
  const liveOutput = useLiveBashOutputView(toolCallId);

  const resultHasOutput = typeof (result as { output?: unknown } | null)?.output === "string";
  const showLiveOutput = status === "executing" || (Boolean(liveOutput) && !resultHasOutput);

  if (showLiveOutput) {
    const combined = liveOutput?.combined ?? "";
    if (combined.trim().length > 0) {
      return (
        <View style={{ gap: theme.spacing.sm }}>
          <ScrollableCodeBlock label="output" text={combined} maxHeight={220} />
          {liveOutput?.truncated ? (
            <ThemedText variant="caption" style={{ color: theme.colors.warning }}>
              Live output truncated
            </ThemedText>
          ) : null}
          {result ? (
            <MetadataList
              items={[
                {
                  label: "duration",
                  value: `${result.wall_duration_ms} ms`,
                },
                {
                  label: "status",
                  value: result.success ? "success" : status,
                  tone: result.success ? "default" : "danger",
                },
              ]}
            />
          ) : null}
        </View>
      );
    }

    if (!result) {
      return <ThemedText variant="muted">Command is executing…</ThemedText>;
    }
  }

  if (!result) {
    return <ThemedText variant="muted">Command is executing…</ThemedText>;
  }

  const stdout = typeof result.output === "string" ? result.output.trim() : "";
  const stderr = result.success ? "" : (result.error?.trim() ?? "");

  return (
    <View style={{ gap: 12 }}>
      {stdout.length > 0 ? <CodeBlock label="stdout" text={stdout} /> : null}
      {stderr.length > 0 ? <CodeBlock label="stderr" text={stderr} tone="danger" /> : null}
      {stdout.length === 0 && stderr.length === 0 ? (
        <CodeBlock label="stdout" text="(no output)" />
      ) : null}
      <MetadataList
        items={[
          {
            label: "duration",
            value: `${result.wall_duration_ms} ms`,
          },
          {
            label: "status",
            value: result.success ? "success" : status,
            tone: result.success ? "default" : "danger",
          },
        ]}
      />
    </View>
  );
}

function FileReadContent({ result }: { result: FileReadToolResult | null }): JSX.Element {
  if (!result) {
    return <ThemedText variant="muted">Reading file…</ThemedText>;
  }

  if (!result.success) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  if (!result.content) {
    return <ThemedText variant="muted">(No content)</ThemedText>;
  }

  const parsed = parseFileReadContent(result.content);

  return (
    <View style={{ gap: 12 }}>
      <FileReadLines lineNumbers={parsed.lineNumbers} lines={parsed.lines} />
      {result.warning ? <CodeBlock label="warning" text={result.warning} tone="warning" /> : null}
    </View>
  );
}

function parseFileReadContent(content: string): {
  lineNumbers: string[];
  lines: string[];
} {
  const lineNumbers: string[] = [];
  const lines: string[] = [];

  content.split("\n").forEach((line) => {
    const tabIndex = line.indexOf("\t");
    if (tabIndex === -1) {
      lineNumbers.push("");
      lines.push(line);
      return;
    }
    lineNumbers.push(line.slice(0, tabIndex));
    lines.push(line.slice(tabIndex + 1));
  });

  return { lineNumbers, lines };
}

function FileReadLines({
  lineNumbers,
  lines,
}: {
  lineNumbers: string[];
  lines: string[];
}): JSX.Element {
  const theme = useTheme();
  return (
    <ScrollView
      style={{
        maxHeight: 220,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: theme.radii.sm,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surfaceSunken,
      }}
    >
      {lines.map((line, index) => (
        <View
          key={`file-read-${index}`}
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: 4,
            borderBottomWidth: index === lines.length - 1 ? 0 : StyleSheet.hairlineWidth,
            borderBottomColor: theme.colors.border,
          }}
        >
          <Text
            style={{
              width: 48,
              textAlign: "right",
              marginRight: theme.spacing.sm,
              color: theme.colors.foregroundSecondary,
              fontFamily: theme.typography.familyMono,
            }}
          >
            {lineNumbers[index]}
          </Text>
          <Text
            style={{
              flex: 1,
              color: theme.colors.foregroundPrimary,
              fontFamily: theme.typography.familyMono,
            }}
          >
            {line === "" ? " " : line}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

function FileEditContent({
  toolName,
  args,
  result,
}: {
  toolName: FileEditToolName;
  args: FileEditArgsUnion;
  result: FileEditResultUnion | null;
}): JSX.Element {
  if (!result) {
    return <ThemedText variant="muted">Waiting for diff…</ThemedText>;
  }

  if (!result.success) {
    return <CodeBlock label="error" text={result.error} tone="danger" />;
  }

  return (
    <View style={{ gap: 12 }}>
      {result.warning ? <CodeBlock label="warning" text={result.warning} tone="warning" /> : null}
      {result.diff ? (
        <DiffPreview diff={result.diff} />
      ) : (
        <ThemedText variant="muted">No diff available.</ThemedText>
      )}
    </View>
  );
}

type FileEditResultUnion =
  | FileEditInsertToolResult
  | FileEditReplaceStringToolResult
  | FileEditReplaceLinesToolResult;

type FileEditArgsUnion =
  | FileEditInsertToolArgs
  | FileEditReplaceStringToolArgs
  | FileEditReplaceLinesToolArgs;

function buildFileEditMetadata(
  toolName: FileEditToolName,
  args: FileEditArgsUnion,
  result: FileEditResultUnion | null
): MetadataItem[] {
  const items: MetadataItem[] = [];

  switch (toolName) {
    case "file_edit_insert": {
      const insertArgs = args as FileEditInsertToolArgs;
      const lineCount = insertArgs.content.split("\n").length;
      items.push({ label: "lines inserted", value: String(lineCount) });
      if (insertArgs.before) {
        items.push({ label: "before", value: truncate(insertArgs.before, 32) });
      }
      if (insertArgs.after) {
        items.push({ label: "after", value: truncate(insertArgs.after, 32) });
      }
      break;
    }
    case "file_edit_replace_lines": {
      const replaceLinesArgs = args as FileEditReplaceLinesToolArgs;
      items.push({
        label: "range",
        value: `${replaceLinesArgs.start_line}-${replaceLinesArgs.end_line}`,
      });
      items.push({
        label: "new lines",
        value: String(replaceLinesArgs.new_lines.length),
      });
      if (result && result.success && "line_delta" in result) {
        items.push({ label: "line delta", value: String(result.line_delta) });
      }
      break;
    }
    case "file_edit_replace_string": {
      const replaceArgs = args as FileEditReplaceStringToolArgs;
      if (result && result.success) {
        const typedResult = result as FileEditReplaceStringToolResult & { success: true };
        if ("edits_applied" in typedResult) {
          items.push({ label: "edits", value: String(typedResult.edits_applied) });
        }
      }
      if (typeof replaceArgs.replace_count === "number") {
        items.push({ label: "limit", value: String(replaceArgs.replace_count) });
      }
      break;
    }
    default:
      break;
  }

  if (result && !result.success) {
    items.push({ label: "status", value: "failed", tone: "danger" });
  }

  return items;
}

function DiffPreview({ diff }: { diff?: string | null }): JSX.Element {
  const theme = useTheme();

  if (!diff) {
    return <ThemedText variant="muted">No diff available.</ThemedText>;
  }

  let rows: DiffRow[];
  try {
    rows = buildDiffRows(diff);
  } catch (error) {
    return (
      <CodeBlock label="error" text={`Failed to parse diff: ${String(error)}`} tone="danger" />
    );
  }

  if (rows.length === 0) {
    return <ThemedText variant="muted">No changes</ThemedText>;
  }

  return (
    <ScrollView
      style={{
        maxHeight: 260,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        borderRadius: theme.radii.sm,
        backgroundColor: theme.colors.surfaceSunken,
      }}
    >
      {rows.map((row) => (
        <View
          key={row.key}
          style={[diffStyles.row, { backgroundColor: getDiffBackground(theme, row.type) }]}
        >
          <Text style={[diffStyles.indicator, { color: getDiffIndicatorColor(theme, row.type) }]}>
            {row.indicator}
          </Text>
          <Text style={[diffStyles.lineNumber, { color: getDiffLineNumberColor(theme, row.type) }]}>
            {row.oldLine ?? ""}
          </Text>
          <Text style={[diffStyles.lineNumber, { color: getDiffLineNumberColor(theme, row.type) }]}>
            {row.newLine ?? ""}
          </Text>
          <Text
            style={{
              flex: 1,
              color: getDiffContentColor(theme, row.type),
              fontFamily: theme.typography.familyMono,
            }}
          >
            {row.text.length === 0 ? " " : row.text}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

interface DiffRow {
  key: string;
  indicator: string;
  type: "add" | "remove" | "context" | "header";
  oldLine?: number;
  newLine?: number;
  text: string;
}

function buildDiffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const patches = parsePatch(diff);

  patches.forEach((patch, patchIndex) => {
    patch.hunks.forEach((hunk, hunkIndex) => {
      rows.push({
        key: `patch-${patchIndex}-hunk-${hunkIndex}-header`,
        indicator: "@@",
        type: "header",
        text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      });

      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;

      hunk.lines.forEach((line, lineIndex) => {
        const indicator = line[0];
        const content = line.slice(1);
        const key = `patch-${patchIndex}-hunk-${hunkIndex}-line-${lineIndex}`;

        if (indicator === "+") {
          rows.push({ key, indicator: "+", type: "add", newLine, text: content });
          newLine++;
        } else if (indicator === "-") {
          rows.push({ key, indicator: "-", type: "remove", oldLine, text: content });
          oldLine++;
        } else if (indicator === "@") {
          rows.push({ key, indicator: "@", type: "header", text: line });
        } else {
          rows.push({
            key,
            indicator: " ",
            type: "context",
            oldLine,
            newLine,
            text: content,
          });
          oldLine++;
          newLine++;
        }
      });
    });
  });

  return rows;
}

const diffStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 4,
    paddingHorizontal: 12,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255, 255, 255, 0.05)",
  },
  indicator: {
    width: 16,
    textAlign: "center",
    fontFamily: "Courier",
  },
  lineNumber: {
    width: 42,
    textAlign: "right",
    fontFamily: "Courier",
  },
});

function getDiffBackground(theme: ReturnType<typeof useTheme>, type: DiffRow["type"]): string {
  switch (type) {
    case "add":
      return "rgba(76, 175, 80, 0.18)";
    case "remove":
      return "rgba(244, 67, 54, 0.18)";
    case "header":
      return "rgba(55, 148, 255, 0.12)";
    default:
      return "transparent";
  }
}

function getDiffIndicatorColor(theme: ReturnType<typeof useTheme>, type: DiffRow["type"]): string {
  switch (type) {
    case "add":
      return theme.colors.success;
    case "remove":
      return theme.colors.error;
    case "header":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundSecondary;
  }
}

function getDiffLineNumberColor(theme: ReturnType<typeof useTheme>, type: DiffRow["type"]): string {
  if (type === "header") {
    return theme.colors.foregroundSecondary;
  }
  return theme.colors.foregroundSecondary;
}

function getDiffContentColor(theme: ReturnType<typeof useTheme>, type: DiffRow["type"]): string {
  switch (type) {
    case "add":
      return theme.colors.foregroundPrimary;
    case "remove":
      return theme.colors.foregroundPrimary;
    case "header":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundPrimary;
  }
}

function CodeBlock({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone?: "default" | "warning" | "danger";
}): JSX.Element {
  const theme = useTheme();
  const palette = getCodeBlockPalette(theme, tone ?? "default");
  return (
    <View
      style={{
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: palette.border,
        backgroundColor: palette.background,
        borderRadius: theme.radii.sm,
        padding: theme.spacing.sm,
        gap: 6,
      }}
    >
      <ThemedText variant="caption" style={{ color: palette.label }}>
        {label}
      </ThemedText>
      <Text
        style={{
          color: palette.textColor,
          fontFamily: theme.typography.familyMono,
          fontSize: 12,
        }}
      >
        {text.length === 0 ? "(empty)" : text}
      </Text>
    </View>
  );
}

function getCodeBlockPalette(
  theme: ReturnType<typeof useTheme>,
  tone: "default" | "warning" | "danger"
) {
  switch (tone) {
    case "warning":
      return {
        background: "rgba(255, 193, 7, 0.08)",
        border: "rgba(255, 193, 7, 0.24)",
        label: theme.colors.warning,
        textColor: theme.colors.foregroundPrimary,
      };
    case "danger":
      return {
        background: "rgba(244, 67, 54, 0.12)",
        border: "rgba(244, 67, 54, 0.32)",
        label: theme.colors.error,
        textColor: theme.colors.foregroundPrimary,
      };
    default:
      return {
        background: theme.colors.surfaceSunken,
        border: theme.colors.border,
        label: theme.colors.foregroundSecondary,
        textColor: theme.colors.foregroundPrimary,
      };
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isBashToolArgs(value: unknown): value is BashToolArgs {
  return Boolean(value && typeof (value as BashToolArgs).script === "string");
}

function isFileReadToolArgs(value: unknown): value is FileReadToolArgs {
  return Boolean(value && typeof (value as FileReadToolArgs).filePath === "string");
}

function isWebFetchToolArgs(value: unknown): value is WebFetchToolArgs {
  return Boolean(value && typeof (value as WebFetchToolArgs).url === "string");
}

function isBashOutputToolArgs(value: unknown): value is BashOutputToolArgs {
  return Boolean(value && typeof (value as BashOutputToolArgs).process_id === "string");
}

function isBashBackgroundListArgs(value: unknown): value is BashBackgroundListArgs {
  return Boolean(value && typeof value === "object");
}

function isBashBackgroundTerminateArgs(value: unknown): value is BashBackgroundTerminateArgs {
  return Boolean(value && typeof (value as BashBackgroundTerminateArgs).process_id === "string");
}

function isTaskToolArgs(value: unknown): value is TaskToolArgs {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (isTaskBashArgsFromUnknown(value)) {
    return true;
  }

  return (
    typeof (value as TaskToolArgs).prompt === "string" &&
    typeof (value as TaskToolArgs).title === "string" &&
    typeof (value as TaskToolArgs).subagent_type === "string"
  );
}

function isTaskAwaitToolArgs(value: unknown): value is TaskAwaitToolArgs {
  if (!value || typeof value !== "object") {
    return false;
  }
  const args = value as TaskAwaitToolArgs;
  if (args.task_ids !== undefined && !Array.isArray(args.task_ids)) {
    return false;
  }
  return true;
}

function isTaskListToolArgs(value: unknown): value is TaskListToolArgs {
  if (!value || typeof value !== "object") {
    return false;
  }
  const args = value as TaskListToolArgs;
  if (args.statuses !== undefined && !Array.isArray(args.statuses)) {
    return false;
  }
  return true;
}

function isTaskTerminateToolArgs(value: unknown): value is TaskTerminateToolArgs {
  return Boolean(value && Array.isArray((value as TaskTerminateToolArgs).task_ids));
}

function isAgentReportToolArgs(value: unknown): value is AgentReportToolArgs {
  return Boolean(value && typeof (value as AgentReportToolArgs).reportMarkdown === "string");
}
function isFileEditArgsUnion(value: unknown): value is FileEditArgsUnion {
  return Boolean(value && typeof (value as FileEditArgsUnion).file_path === "string");
}

function coerceWebFetchToolResult(value: unknown): WebFetchToolResult | null {
  if (value && typeof value === "object" && "success" in value) {
    return value as WebFetchToolResult;
  }
  return null;
}

function coerceBashOutputToolResult(value: unknown): BashOutputToolResult | null {
  if (value && typeof value === "object" && "success" in value) {
    return value as BashOutputToolResult;
  }
  return null;
}

function coerceBashBackgroundListResult(value: unknown): BashBackgroundListResult | null {
  if (value && typeof value === "object" && "success" in value) {
    return value as BashBackgroundListResult;
  }
  return null;
}

function coerceBashBackgroundTerminateResult(value: unknown): BashBackgroundTerminateResult | null {
  if (value && typeof value === "object" && "success" in value) {
    return value as BashBackgroundTerminateResult;
  }
  return null;
}

function coerceFileReadToolResult(value: unknown): FileReadToolResult | null {
  if (value && typeof value === "object" && "success" in value) {
    return value as FileReadToolResult;
  }
  return null;
}

function coerceFileEditResultUnion(value: unknown): FileEditResultUnion | null {
  if (value && typeof value === "object" && "success" in value) {
    return value as FileEditResultUnion;
  }
  return null;
}

function coerceTaskToolResult(value: unknown): TaskToolResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("success" in value && typeof (value as { success?: unknown }).success === "boolean") {
    return value as TaskToolResult;
  }
  if ("status" in value && typeof (value as { status?: unknown }).status === "string") {
    return value as TaskToolResult;
  }
  return null;
}

function coerceTaskAwaitToolResult(value: unknown): TaskAwaitToolResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("success" in value && typeof (value as { success?: unknown }).success === "boolean") {
    return value as TaskAwaitToolResult;
  }
  if ("results" in value && Array.isArray((value as { results?: unknown }).results)) {
    return value as TaskAwaitToolResult;
  }
  return null;
}

function coerceTaskListToolResult(value: unknown): TaskListToolResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("success" in value && typeof (value as { success?: unknown }).success === "boolean") {
    return value as TaskListToolResult;
  }
  if ("tasks" in value && Array.isArray((value as { tasks?: unknown }).tasks)) {
    return value as TaskListToolResult;
  }
  return null;
}

function coerceTaskTerminateToolResult(value: unknown): TaskTerminateToolResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("success" in value && typeof (value as { success?: unknown }).success === "boolean") {
    return value as TaskTerminateToolResult;
  }
  if ("results" in value && Array.isArray((value as { results?: unknown }).results)) {
    return value as TaskTerminateToolResult;
  }
  return null;
}

function coerceAgentReportToolResult(value: unknown): AgentReportToolResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("success" in value && typeof (value as { success?: unknown }).success === "boolean") {
    return value as AgentReportToolResult;
  }
  return null;
}
