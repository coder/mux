import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { SelectableList } from "@/cli/tui/components/SelectableList";
import type { APIClient, TuiAction, TuiState, TuiWorkspace } from "@/cli/tui/tuiTypes";

interface WorkspacesScreenProps {
  api: APIClient;
  state: TuiState;
  dispatch: React.Dispatch<TuiAction>;
  projectPath: string;
  projectName: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function WorkspacesScreen(props: WorkspacesScreenProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const api = props.api;
  const dispatch = props.dispatch;
  const projectPath = props.projectPath;
  const projectName = props.projectName;

  useEffect(() => {
    let cancelled = false;

    const loadWorkspaces = async (): Promise<void> => {
      dispatch({ type: "SET_LOADING", loading: true });
      dispatch({ type: "SET_ERROR", error: null });

      const allWorkspaces = await api.workspace.list();
      if (cancelled) {
        return;
      }

      const filtered = mapWorkspaces(allWorkspaces, projectPath);
      dispatch({ type: "SET_WORKSPACES", workspaces: filtered });
      setSelectedIndex((current) => {
        if (filtered.length === 0) {
          return 0;
        }

        return Math.min(current, filtered.length - 1);
      });
      dispatch({ type: "SET_LOADING", loading: false });
    };

    loadWorkspaces().catch((error: unknown) => {
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
  }, [api, dispatch, projectPath]);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (props.state.workspaces.length === 0) {
        return 0;
      }

      return Math.min(current, props.state.workspaces.length - 1);
    });
  }, [props.state.workspaces.length]);

  useInput((input, key) => {
    if (props.state.loading) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(props.state.workspaces.length - 1, current + 1));
      return;
    }

    if (key.return) {
      const boundedIndex = Math.min(selectedIndex, Math.max(0, props.state.workspaces.length - 1));
      const selectedWorkspace = props.state.workspaces[boundedIndex];
      if (!selectedWorkspace) {
        return;
      }

      dispatch({
        type: "NAVIGATE",
        screen: {
          type: "chat",
          workspaceId: selectedWorkspace.id,
          projectPath: selectedWorkspace.projectPath,
          projectName: selectedWorkspace.projectName,
        },
      });
      return;
    }

    if (input === "n") {
      dispatch({
        type: "NAVIGATE",
        screen: {
          type: "createWorkspace",
          projectPath,
          projectName,
        },
      });
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Workspaces · {projectName}</Text>
      <Text dimColor>Enter: open chat · n: new workspace · Esc: back</Text>

      {props.state.error ? <Text color="red">{props.state.error}</Text> : null}

      {props.state.loading && props.state.workspaces.length === 0 ? (
        <Text dimColor>Loading workspaces…</Text>
      ) : props.state.workspaces.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text>No workspaces found for this project.</Text>
          <Text dimColor>Press n to create a workspace.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <SelectableList
            items={props.state.workspaces}
            selectedIndex={selectedIndex}
            renderItem={(workspace) => {
              const label = workspace.title?.trim().length ? workspace.title : workspace.name;
              return `${label} (${workspace.name})`;
            }}
            maxVisible={12}
          />
        </Box>
      )}
    </Box>
  );
}
