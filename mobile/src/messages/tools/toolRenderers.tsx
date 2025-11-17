import type { ReactNode } from "react";
import React from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { parsePatch } from "diff";
import type { DisplayedMessage } from "@/common/types/message";
import {
  FILE_EDIT_TOOL_NAMES,
  type BashToolArgs,
  type BashToolResult,
  type FileEditInsertToolArgs,
  type FileEditInsertToolResult,
  type FileEditReplaceLinesToolArgs,
  type FileEditReplaceLinesToolResult,
  type FileEditReplaceStringToolArgs,
  type FileEditReplaceStringToolResult,
  type FileEditToolName,
  type FileReadToolArgs,
  type FileReadToolResult,
} from "@/common/types/tools";
import { useTheme } from "../../theme";
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
  if (result && result.truncated) {
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
    content: <BashToolContent args={args} result={result} status={message.status} />,
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
}: {
  args: BashToolArgs;
  result: BashToolResult | null;
  status: ToolDisplayedMessage["status"];
}): JSX.Element {
  if (!result) {
    return <ThemedText variant="muted">Command is executing…</ThemedText>;
  }

  const stdout = result.output?.trim() ?? "";
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

function isFileEditArgsUnion(value: unknown): value is FileEditArgsUnion {
  return Boolean(value && typeof (value as FileEditArgsUnion).file_path === "string");
}

function coerceBashToolResult(value: unknown): BashToolResult | null {
  if (
    value &&
    typeof value === "object" &&
    "success" in value &&
    typeof (value as BashToolResult).success === "boolean"
  ) {
    return value as BashToolResult;
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
