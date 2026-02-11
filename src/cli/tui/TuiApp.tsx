import { useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { initialState, tuiReducer } from "./tuiStore";
import type { APIClient, TuiOptions } from "./tuiTypes";

interface TuiAppProps {
  api: APIClient;
  options: TuiOptions;
}

function RenderShell(props: { children: string; options: TuiOptions; api: APIClient }) {
  return (
    <Box flexDirection="column">
      <Text>{props.children}</Text>
      <Text dimColor>
        Model: {props.options.model} · Agent: {props.options.agentId} · API: {typeof props.api}
      </Text>
    </Box>
  );
}

export function TuiApp(props: TuiAppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(tuiReducer, initialState);

  // Global keybindings
  useInput((input, key) => {
    if (input === "q" && state.screen.type !== "chat") {
      exit();
      return;
    }

    if (key.escape) {
      // Navigate back
      if (state.screen.type === "workspaces") {
        dispatch({ type: "NAVIGATE", screen: { type: "projects" } });
      } else if (state.screen.type === "chat") {
        dispatch({
          type: "NAVIGATE",
          screen: {
            type: "workspaces",
            projectPath: state.screen.projectPath,
            projectName: state.screen.projectName,
          },
        });
      }
      // createProject / createWorkspace: back handled within those screens
    }
  });

  // Render current screen (placeholders for now — real screens added in follow-up)
  const screen = state.screen;
  switch (screen.type) {
    case "projects":
      return (
        <RenderShell api={props.api} options={props.options}>
          {"Projects Screen (placeholder) — press q to quit"}
        </RenderShell>
      );
    case "workspaces":
      return (
        <RenderShell api={props.api} options={props.options}>
          {`Workspaces for ${screen.projectName} — press Esc to go back`}
        </RenderShell>
      );
    case "chat":
      return (
        <RenderShell api={props.api} options={props.options}>
          {`Chat for workspace ${screen.workspaceId} — press Esc to go back`}
        </RenderShell>
      );
    case "createProject":
      return (
        <RenderShell api={props.api} options={props.options}>
          {"Create Project (placeholder)"}
        </RenderShell>
      );
    case "createWorkspace":
      return (
        <RenderShell api={props.api} options={props.options}>
          {`Create Workspace for ${screen.projectName} (placeholder)`}
        </RenderShell>
      );
    default:
      return <Text>Unknown screen</Text>;
  }
}
