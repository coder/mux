import { useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { SelectableList } from "@/cli/tui/components/SelectableList";
import type { APIClient, TuiAction, TuiProject, TuiState, TuiWorkspace } from "@/cli/tui/tuiTypes";

const PROJECT_MAX_VISIBLE = 8;
const WORKSPACE_MAX_VISIBLE = 10;

interface SidebarProps {
  api: APIClient;
  state: TuiState;
  dispatch: React.Dispatch<TuiAction>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deriveProjectName(projectPath: string): string {
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

function mapProjects(projectEntries: unknown): TuiProject[] {
  if (!Array.isArray(projectEntries)) {
    return [];
  }

  const mapped: TuiProject[] = [];
  for (const entry of projectEntries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      continue;
    }

    const projectPath = entry[0];
    mapped.push({
      path: projectPath,
      name: deriveProjectName(projectPath),
    });
  }

  return mapped;
}

function mapWorkspaces(workspaceEntries: unknown, projectPath: string): TuiWorkspace[] {
  if (!Array.isArray(workspaceEntries)) {
    return [];
  }

  const mapped: TuiWorkspace[] = [];
  for (const entry of workspaceEntries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = entry as {
      id?: unknown;
      name?: unknown;
      title?: unknown;
      projectPath?: unknown;
      projectName?: unknown;
    };

    if (
      typeof record.id !== "string" ||
      typeof record.name !== "string" ||
      typeof record.projectPath !== "string" ||
      typeof record.projectName !== "string"
    ) {
      continue;
    }

    if (record.projectPath !== projectPath) {
      continue;
    }

    mapped.push({
      id: record.id,
      name: record.name,
      title: typeof record.title === "string" ? record.title : undefined,
      projectPath: record.projectPath,
      projectName: record.projectName,
    });
  }

  return mapped;
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

export function Sidebar(props: SidebarProps) {
  const api = props.api;
  const state = props.state;
  const dispatch = props.dispatch;

  const selectedProjectIndex = clampIndex(state.selectedProjectIndex, state.projects.length);
  const selectedWorkspaceIndex = clampIndex(state.selectedWorkspaceIndex, state.workspaces.length);
  const selectedProject = state.projects[selectedProjectIndex] ?? null;

  useEffect(() => {
    let cancelled = false;

    const loadProjects = async (): Promise<void> => {
      dispatch({ type: "SET_LOADING", loading: true });
      dispatch({ type: "SET_ERROR", error: null });

      const listedProjects = await api.projects.list();
      if (cancelled) {
        return;
      }

      dispatch({ type: "SET_PROJECTS", projects: mapProjects(listedProjects) });
      dispatch({ type: "SET_LOADING", loading: false });
    };

    loadProjects().catch((error: unknown) => {
      if (cancelled) {
        return;
      }

      dispatch({
        type: "SET_ERROR",
        error: `Failed to load projects: ${toErrorMessage(error)}`,
      });
      dispatch({ type: "SET_LOADING", loading: false });
    });

    return () => {
      cancelled = true;
    };
  }, [api, dispatch]);

  useEffect(() => {
    let cancelled = false;

    const selectedProjectPath = selectedProject?.path;
    if (!selectedProjectPath) {
      dispatch({ type: "SET_WORKSPACES", workspaces: [] });
      dispatch({ type: "SET_WORKSPACE_ACTIVITY", activity: {} });
      return;
    }

    const loadProjectWorkspaces = async (): Promise<void> => {
      dispatch({ type: "SET_LOADING", loading: true });
      dispatch({ type: "SET_ERROR", error: null });

      const allWorkspaces = await api.workspace.list();
      const activity = await api.workspace.activity.list();
      if (cancelled) {
        return;
      }

      const filteredWorkspaces = mapWorkspaces(allWorkspaces, selectedProjectPath);
      dispatch({ type: "SET_WORKSPACES", workspaces: filteredWorkspaces });
      dispatch({ type: "SET_WORKSPACE_ACTIVITY", activity });
      dispatch({ type: "SET_LOADING", loading: false });
    };

    loadProjectWorkspaces().catch((error: unknown) => {
      if (cancelled) {
        return;
      }

      dispatch({
        type: "SET_ERROR",
        error: `Failed to load workspaces: ${toErrorMessage(error)}`,
      });
      dispatch({ type: "SET_LOADING", loading: false });
    });

    return () => {
      cancelled = true;
    };
  }, [api, dispatch, selectedProject?.path]);

  useInput((input, key) => {
    if (state.loading) {
      return;
    }

    if (state.focus === "sidebar-projects") {
      if (key.upArrow) {
        dispatch({ type: "SELECT_PROJECT", index: selectedProjectIndex - 1 });
        return;
      }

      if (key.downArrow) {
        dispatch({ type: "SELECT_PROJECT", index: selectedProjectIndex + 1 });
        return;
      }

      if (key.return) {
        if (!selectedProject) {
          return;
        }

        dispatch({ type: "SET_FOCUS", focus: "sidebar-workspaces" });
        return;
      }

      if (input === "n") {
        dispatch({ type: "SET_FOCUS", focus: "create-project" });
      }

      return;
    }

    if (state.focus !== "sidebar-workspaces") {
      return;
    }

    if (key.upArrow) {
      dispatch({ type: "SELECT_WORKSPACE", index: selectedWorkspaceIndex - 1 });
      return;
    }

    if (key.downArrow) {
      dispatch({ type: "SELECT_WORKSPACE", index: selectedWorkspaceIndex + 1 });
      return;
    }

    if (key.return) {
      const selectedWorkspace = state.workspaces[selectedWorkspaceIndex];
      if (!selectedWorkspace) {
        return;
      }

      dispatch({
        type: "OPEN_WORKSPACE",
        workspaceId: selectedWorkspace.id,
        projectPath: selectedWorkspace.projectPath,
        projectName: selectedWorkspace.projectName,
      });
      dispatch({ type: "SET_FOCUS", focus: "chat" });
      return;
    }

    if (input === "n") {
      if (!selectedProject) {
        return;
      }

      dispatch({ type: "SET_FOCUS", focus: "create-workspace" });
      return;
    }

    if (key.escape) {
      dispatch({ type: "SET_FOCUS", focus: "sidebar-projects" });
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={state.focus === "sidebar-projects" ? "cyan" : undefined}>
        Projects
      </Text>
      <Text dimColor>Enter: workspaces · n: new</Text>
      {state.projects.length === 0 ? (
        <Text dimColor>No projects</Text>
      ) : (
        <SelectableList
          items={state.projects}
          selectedIndex={selectedProjectIndex}
          renderItem={(project) => project.name}
          maxVisible={PROJECT_MAX_VISIBLE}
        />
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold color={state.focus === "sidebar-workspaces" ? "cyan" : undefined}>
          Workspaces
        </Text>
        <Text dimColor>Enter: chat · n: new · Esc: projects</Text>
        {selectedProject ? (
          state.workspaces.length === 0 ? (
            <Text dimColor>No workspaces</Text>
          ) : (
            <SelectableList
              items={state.workspaces}
              selectedIndex={selectedWorkspaceIndex}
              renderItem={(workspace) => {
                const activity = state.workspaceActivity[workspace.id];
                const isStreaming = activity?.streaming === true;
                const label = workspace.title?.trim().length ? workspace.title : workspace.name;

                return (
                  <Box>
                    <Text>{label}</Text>
                    <Text color={isStreaming ? "green" : undefined} dimColor={!isStreaming}>
                      {isStreaming ? " ●" : " ○"}
                    </Text>
                  </Box>
                );
              }}
              maxVisible={WORKSPACE_MAX_VISIBLE}
            />
          )
        ) : (
          <Text dimColor>Select a project</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>[n] new [q] quit</Text>
      </Box>

      {state.error ? (
        <Box marginTop={1}>
          <Text color="red">{state.error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
