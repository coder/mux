import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { APIClient, TuiAction, TuiState } from "@/cli/tui/tuiTypes";

interface CreateProjectScreenProps {
  api: APIClient;
  state: TuiState;
  dispatch: React.Dispatch<TuiAction>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CreateProjectScreen(props: CreateProjectScreenProps) {
  const [projectPath, setProjectPath] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submitProject = async (): Promise<void> => {
    const trimmedPath = projectPath.trim();
    if (!trimmedPath) {
      setLocalError("Please enter a project path.");
      return;
    }

    setIsCreating(true);
    setLocalError(null);
    props.dispatch({ type: "SET_ERROR", error: null });

    try {
      const result = await props.api.projects.create({ projectPath: trimmedPath });
      if (!result.success) {
        const message = typeof result.error === "string" ? result.error : "Failed to create project.";
        setLocalError(message);
        props.dispatch({ type: "SET_ERROR", error: message });
        return;
      }

      setProjectPath("");
      props.dispatch({ type: "NAVIGATE", screen: { type: "projects" } });
    } catch (error: unknown) {
      const message = `Failed to create project: ${toErrorMessage(error)}`;
      setLocalError(message);
      props.dispatch({ type: "SET_ERROR", error: message });
    } finally {
      setIsCreating(false);
    }
  };

  useInput((_input, key) => {
    if (!key.escape || isCreating) {
      return;
    }

    props.dispatch({ type: "NAVIGATE", screen: { type: "projects" } });
  });

  return (
    <Box flexDirection="column">
      <Text bold>Create Project</Text>
      <Text dimColor>Enter a path and press Enter. Esc to cancel.</Text>

      <Box marginTop={1}>
        <Text color="cyan">Path: </Text>
        <TextInput
          value={projectPath}
          onChange={setProjectPath}
          onSubmit={() => {
            if (isCreating) {
              return;
            }

            submitProject().catch((error: unknown) => {
              const message = `Failed to create project: ${toErrorMessage(error)}`;
              setLocalError(message);
              props.dispatch({ type: "SET_ERROR", error: message });
            });
          }}
          placeholder="/path/to/project"
        />
      </Box>

      {isCreating ? <Text dimColor>Creating project…</Text> : null}
      {localError ? <Text color="red">{localError}</Text> : null}
      {!localError && props.state.error ? <Text color="red">{props.state.error}</Text> : null}
    </Box>
  );
}
