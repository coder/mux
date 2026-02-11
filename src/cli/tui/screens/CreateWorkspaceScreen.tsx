import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { APIClient, TuiAction, TuiState } from "@/cli/tui/tuiTypes";

interface CreateWorkspaceScreenProps {
  api: APIClient;
  state: TuiState;
  dispatch: React.Dispatch<TuiAction>;
  projectPath: string;
  projectName: string;
}

type CreateWorkspaceStep = "branch" | "title";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeBranchList(branches: unknown): string[] {
  if (!Array.isArray(branches)) {
    return [];
  }

  return branches.filter((branch): branch is string => typeof branch === "string");
}

export function CreateWorkspaceScreen(props: CreateWorkspaceScreenProps) {
  const [step, setStep] = useState<CreateWorkspaceStep>("branch");
  const [branchName, setBranchName] = useState("");
  const [title, setTitle] = useState("");
  const [recommendedTrunk, setRecommendedTrunk] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const api = props.api;
  const dispatch = props.dispatch;
  const projectPath = props.projectPath;
  const projectName = props.projectName;

  useEffect(() => {
    let cancelled = false;

    const loadBranches = async (): Promise<void> => {
      dispatch({ type: "SET_LOADING", loading: true });
      dispatch({ type: "SET_ERROR", error: null });

      const result = await api.projects.listBranches({ projectPath });
      if (cancelled) {
        return;
      }

      setRecommendedTrunk(result.recommendedTrunk ?? null);
      setBranches(sanitizeBranchList(result.branches));
      dispatch({ type: "SET_LOADING", loading: false });
    };

    loadBranches().catch((error: unknown) => {
      if (cancelled) {
        return;
      }

      const message = `Failed to load branches: ${toErrorMessage(error)}`;
      setLocalError(message);
      dispatch({ type: "SET_ERROR", error: message });
      dispatch({ type: "SET_LOADING", loading: false });
    });

    return () => {
      cancelled = true;
    };
  }, [api, dispatch, projectPath]);

  const navigateBack = () => {
    dispatch({
      type: "NAVIGATE",
      screen: {
        type: "workspaces",
        projectPath,
        projectName,
      },
    });
  };

  const createWorkspace = async (): Promise<void> => {
    const trimmedBranchName = branchName.trim();
    if (!trimmedBranchName) {
      setLocalError("Please enter a branch name.");
      return;
    }

    setIsCreating(true);
    setLocalError(null);
    dispatch({ type: "SET_ERROR", error: null });

    try {
      const trimmedTitle = title.trim();
      const result = await api.workspace.create({
        projectPath,
        branchName: trimmedBranchName,
        trunkBranch: recommendedTrunk ?? undefined,
        title: trimmedTitle.length > 0 ? trimmedTitle : undefined,
        runtimeConfig: { type: "local" },
      });

      if (!result.success) {
        const message =
          typeof result.error === "string" ? result.error : "Failed to create workspace.";
        setLocalError(message);
        dispatch({ type: "SET_ERROR", error: message });
        return;
      }

      dispatch({
        type: "NAVIGATE",
        screen: {
          type: "chat",
          workspaceId: result.metadata.id,
          projectPath: result.metadata.projectPath,
          projectName: result.metadata.projectName,
        },
      });
    } catch (error: unknown) {
      const message = `Failed to create workspace: ${toErrorMessage(error)}`;
      setLocalError(message);
      dispatch({ type: "SET_ERROR", error: message });
    } finally {
      setIsCreating(false);
    }
  };

  const handleSubmit = () => {
    if (step === "branch") {
      if (!branchName.trim()) {
        setLocalError("Please enter a branch name.");
        return;
      }

      setLocalError(null);
      setStep("title");
      return;
    }

    createWorkspace().catch((error: unknown) => {
      const message = `Failed to create workspace: ${toErrorMessage(error)}`;
      setLocalError(message);
      dispatch({ type: "SET_ERROR", error: message });
    });
  };

  useInput((_input, key) => {
    if (!key.escape || isCreating) {
      return;
    }

    if (step === "title") {
      setStep("branch");
      setLocalError(null);
      return;
    }

    navigateBack();
  });

  const activeValue = step === "branch" ? branchName : title;

  return (
    <Box flexDirection="column">
      <Text bold>Create Workspace · {projectName}</Text>
      <Text dimColor>
        {step === "branch"
          ? "Step 1/2: enter branch name. Enter to continue. Esc to cancel."
          : "Step 2/2: optional title. Enter to create. Esc to edit branch."}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Recommended trunk: {recommendedTrunk ?? "(none)"}</Text>
        {branches.length > 0 ? (
          <Text dimColor>Detected branches: {branches.slice(0, 6).join(", ")}</Text>
        ) : (
          <Text dimColor>No git branches detected.</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="cyan">{step === "branch" ? "Branch: " : "Title: "}</Text>
        <TextInput
          value={activeValue}
          onChange={(value) => {
            if (step === "branch") {
              setBranchName(value);
            } else {
              setTitle(value);
            }
          }}
          onSubmit={handleSubmit}
          placeholder={step === "branch" ? "feature/my-task" : "Optional workspace title"}
        />
      </Box>

      {isCreating ? <Text dimColor>Creating workspace…</Text> : null}
      {localError ? <Text color="red">{localError}</Text> : null}
      {!localError && props.state.error ? <Text color="red">{props.state.error}</Text> : null}
    </Box>
  );
}
