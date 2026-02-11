import { Box, Text } from "ink";

const RESULT_PREVIEW_MAX_LENGTH = 80;

interface ToolCallBlockProps {
  toolName: string;
  status: "running" | "completed";
  result?: string;
  isActive?: boolean;
}

function truncateResult(result: string, maxLength: number): string {
  const singleLine = result.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function ToolCallBlock(props: ToolCallBlockProps) {
  const isRunning = props.status === "running";
  const icon = isRunning ? "●" : "✓";
  const iconColor = isRunning ? "yellow" : "green";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold={props.isActive === true}>
        <Text color={iconColor}>{icon}</Text> {props.toolName}
        <Text dimColor>{` (${props.status})`}</Text>
      </Text>

      {props.result ? (
        <Text dimColor>{`  └─ ${truncateResult(props.result, RESULT_PREVIEW_MAX_LENGTH)}`}</Text>
      ) : null}
    </Box>
  );
}
