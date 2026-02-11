import { useReducer } from "react";
import { Text, useApp, useInput } from "ink";
import { ProjectsScreen } from "@/cli/tui/screens/ProjectsScreen";
import { CreateProjectScreen } from "@/cli/tui/screens/CreateProjectScreen";
import { WorkspacesScreen } from "@/cli/tui/screens/WorkspacesScreen";
import { CreateWorkspaceScreen } from "@/cli/tui/screens/CreateWorkspaceScreen";
import { ChatScreen } from "@/cli/tui/screens/ChatScreen";
import { initialState, tuiReducer } from "./tuiStore";
import type { APIClient, TuiOptions } from "./tuiTypes";

interface TuiAppProps {
  api: APIClient;
  options: TuiOptions;
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

    if (!key.escape) {
      return;
    }

    // Navigate back
    if (state.screen.type === "workspaces") {
      dispatch({ type: "NAVIGATE", screen: { type: "projects" } });
      return;
    }

    if (state.screen.type === "chat") {
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
  });

  const screen = state.screen;
  switch (screen.type) {
    case "projects":
      return <ProjectsScreen api={props.api} state={state} dispatch={dispatch} />;
    case "workspaces":
      return (
        <WorkspacesScreen
          api={props.api}
          state={state}
          dispatch={dispatch}
          projectPath={screen.projectPath}
          projectName={screen.projectName}
        />
      );
    case "chat":
      return (
        <ChatScreen
          api={props.api}
          state={state}
          dispatch={dispatch}
          workspaceId={screen.workspaceId}
          options={props.options}
        />
      );
    case "createProject":
      return <CreateProjectScreen api={props.api} state={state} dispatch={dispatch} />;
    case "createWorkspace":
      return (
        <CreateWorkspaceScreen
          api={props.api}
          state={state}
          dispatch={dispatch}
          projectPath={screen.projectPath}
          projectName={screen.projectName}
        />
      );
    default:
      return <Text>Unknown screen</Text>;
  }
}
