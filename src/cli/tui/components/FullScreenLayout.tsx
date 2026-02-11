import type { ReactNode } from "react";
import { Box, useStdout } from "ink";

export const SIDEBAR_WIDTH = 30;

interface FullScreenLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
}

export function FullScreenLayout(props: FullScreenLayoutProps) {
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;

  return (
    <Box width={columns} height={rows}>
      <Box
        width={SIDEBAR_WIDTH}
        borderStyle="single"
        borderRight
        borderColor="gray"
        flexDirection="column"
      >
        {props.sidebar}
      </Box>
      <Box flexGrow={1} flexDirection="column" paddingLeft={1}>
        {props.main}
      </Box>
    </Box>
  );
}
