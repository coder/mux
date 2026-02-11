import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { SelectableList } from "@/cli/tui/components/SelectableList";
import type { APIClient, TuiAction, TuiProject, TuiState } from "@/cli/tui/tuiTypes";

interface ProjectsScreenProps {
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

  const projects: TuiProject[] = [];
  for (const entry of projectEntries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      continue;
    }

    const projectPath = entry[0];
    projects.push({
      path: projectPath,
      name: deriveProjectName(projectPath),
    });
  }

  return projects;
}

export function ProjectsScreen(props: ProjectsScreenProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const api = props.api;
  const dispatch = props.dispatch;

  useEffect(() => {
    let cancelled = false;

    const loadProjects = async (): Promise<void> => {
      dispatch({ type: "SET_LOADING", loading: true });
      dispatch({ type: "SET_ERROR", error: null });

      const result = await api.projects.list();
      if (cancelled) {
        return;
      }

      const projects = mapProjects(result);
      dispatch({ type: "SET_PROJECTS", projects });
      setSelectedIndex((current) => {
        if (projects.length === 0) {
          return 0;
        }

        return Math.min(current, projects.length - 1);
      });
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
    setSelectedIndex((current) => {
      if (props.state.projects.length === 0) {
        return 0;
      }

      return Math.min(current, props.state.projects.length - 1);
    });
  }, [props.state.projects.length]);

  useInput((input, key) => {
    if (props.state.loading) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(props.state.projects.length - 1, current + 1));
      return;
    }

    if (key.return) {
      const boundedIndex = Math.min(selectedIndex, Math.max(0, props.state.projects.length - 1));
      const selectedProject = props.state.projects[boundedIndex];
      if (!selectedProject) {
        return;
      }

      dispatch({
        type: "NAVIGATE",
        screen: {
          type: "workspaces",
          projectPath: selectedProject.path,
          projectName: selectedProject.name,
        },
      });
      return;
    }

    if (input === "n") {
      dispatch({ type: "NAVIGATE", screen: { type: "createProject" } });
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Projects</Text>
      <Text dimColor>Enter: open project · n: new project · q: quit</Text>

      {props.state.error ? <Text color="red">{props.state.error}</Text> : null}

      {props.state.loading && props.state.projects.length === 0 ? (
        <Text dimColor>Loading projects…</Text>
      ) : props.state.projects.length === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>No projects found.</Text>
          <Text dimColor>Press n to create your first project.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <SelectableList
            items={props.state.projects}
            selectedIndex={selectedIndex}
            renderItem={(project) => `${project.name} (${project.path})`}
            maxVisible={12}
          />
        </Box>
      )}
    </Box>
  );
}
