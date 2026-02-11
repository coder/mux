import type { ReactNode } from "react";
import { Box, Text, useStdout } from "ink";

export const SIDEBAR_WIDTH = 30;

interface FullScreenLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  focus: string;
}

export function FullScreenLayout(props: FullScreenLayoutProps) {
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;

  const sidebarFocused =
    props.focus.startsWith("sidebar") ||
    props.focus === "create-project" ||
    props.focus === "create-workspace";
  const mainFocused = props.focus === "chat";
  const contentHeight = Math.max(1, rows - 1);

  return (
    <Box width={columns} height={rows} flexDirection="column">
      <Box height={contentHeight}>
        <Box
          width={SIDEBAR_WIDTH}
          borderStyle="single"
          borderColor={sidebarFocused ? "cyan" : "gray"}
          flexDirection="column"
        >
          {props.sidebar}
        </Box>
        <Box
          flexGrow={1}
          borderStyle="single"
          borderColor={mainFocused ? "cyan" : "gray"}
          flexDirection="column"
        >
          {props.main}
        </Box>
      </Box>

      <Box>
        <Text dimColor>
          {" [Tab] switch pane  [↑/↓] navigate  [Enter] select  [n] new  [q] quit"}
        </Text>
      </Box>
    </Box>
  );
}
