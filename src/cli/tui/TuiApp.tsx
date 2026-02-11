import { useReducer } from "react";
import type { ReactNode } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { FullScreenLayout } from "@/cli/tui/components/FullScreenLayout";
import { Sidebar } from "@/cli/tui/components/Sidebar";
import { CreateProjectScreen } from "@/cli/tui/screens/CreateProjectScreen";
import { CreateWorkspaceScreen } from "@/cli/tui/screens/CreateWorkspaceScreen";
import { ChatScreen } from "@/cli/tui/screens/ChatScreen";
import { initialState, tuiReducer } from "./tuiStore";
import type { APIClient, TuiOptions } from "./tuiTypes";

interface TuiAppProps {
  api: APIClient;
  options: TuiOptions;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  if (index < 0) {
    return 0;
  }

  if (index >= length) {
    return length - 1;
  }

  return index;
}

export function TuiApp(props: TuiAppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(tuiReducer, initialState);

  const selectedProjectIndex = clampIndex(state.selectedProjectIndex, state.projects.length);
  const selectedProject = state.projects[selectedProjectIndex] ?? null;

  // Global keybindings
  useInput((input, key) => {
    if (input === "q" && state.focus !== "chat") {
      exit();
      return;
    }

    if (!key.tab) {
      return;
    }

    if (state.focus === "chat") {
      dispatch({ type: "SET_FOCUS", focus: "sidebar-workspaces" });
      return;
    }

    if (state.focus === "sidebar-projects" || state.focus === "sidebar-workspaces") {
      if (state.activeWorkspaceId) {
        dispatch({ type: "SET_FOCUS", focus: "chat" });
      }
      return;
    }

    if (state.focus === "create-project") {
      dispatch({ type: "SET_FOCUS", focus: "sidebar-projects" });
      return;
    }

    dispatch({ type: "SET_FOCUS", focus: "sidebar-workspaces" });
  });

  let mainPanel: ReactNode;
  if (state.focus === "create-project") {
    mainPanel = <CreateProjectScreen api={props.api} state={state} dispatch={dispatch} />;
  } else if (state.focus === "create-workspace") {
    if (selectedProject) {
      mainPanel = (
        <CreateWorkspaceScreen
          api={props.api}
          state={state}
          dispatch={dispatch}
          projectPath={selectedProject.path}
          projectName={selectedProject.name}
        />
      );
    } else {
      mainPanel = (
        <Box paddingLeft={1} paddingTop={1}>
          <Text dimColor>Select a project before creating a workspace.</Text>
        </Box>
      );
    }
  } else if (state.activeWorkspaceId) {
    const activeWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.activeWorkspaceId
    );
    const workspaceLabel = activeWorkspace
      ? activeWorkspace.title?.trim().length
        ? activeWorkspace.title
        : activeWorkspace.name
      : state.activeWorkspaceId;

    mainPanel = (
      <ChatScreen
        api={props.api}
        state={state}
        dispatch={dispatch}
        workspaceId={state.activeWorkspaceId}
        workspaceLabel={workspaceLabel}
        options={props.options}
      />
    );
  } else {
    mainPanel = (
      <Box paddingLeft={1} paddingTop={1}>
        <Text dimColor>Select a workspace to start chatting</Text>
      </Box>
    );
  }

  return (
    <FullScreenLayout
      sidebar={<Sidebar api={props.api} state={state} dispatch={dispatch} />}
      main={mainPanel}
      focus={state.focus}
    />
  );
}
