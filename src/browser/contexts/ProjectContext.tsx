import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAPI } from "@/browser/contexts/API";
import type { ProjectConfig } from "@/node/config";
import type { BranchListResult } from "@/common/orpc/types";
import type { Secret } from "@/common/types/secrets";

interface WorkspaceModalState {
  isOpen: boolean;
  projectPath: string | null;
  projectName: string;
  branches: string[];
  defaultTrunkBranch?: string;
  loadErrorMessage: string | null;
  isLoading: boolean;
}

export interface ProjectContext {
  projects: Map<string, ProjectConfig>;
  refreshProjects: () => Promise<void>;
  addProject: (normalizedPath: string, projectConfig: ProjectConfig) => void;
  removeProject: (path: string) => Promise<void>;

  // Project creation modal
  isProjectCreateModalOpen: boolean;
  openProjectCreateModal: () => void;
  closeProjectCreateModal: () => void;

  // Workspace modal state
  workspaceModalState: WorkspaceModalState;
  openWorkspaceModal: (projectPath: string, options?: { projectName?: string }) => Promise<void>;
  closeWorkspaceModal: () => void;

  // Helpers
  getBranchesForProject: (projectPath: string) => Promise<BranchListResult>;
  getSecrets: (projectPath: string) => Promise<Secret[]>;
  updateSecrets: (projectPath: string, secrets: Secret[]) => Promise<void>;
}

const ProjectContext = createContext<ProjectContext | undefined>(undefined);

function deriveProjectName(projectPath: string): string {
  if (!projectPath) {
    return "Project";
  }
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

export function ProjectProvider(props: { children: ReactNode }) {
  const { api } = useAPI();
  const [projects, setProjects] = useState<Map<string, ProjectConfig>>(new Map());
  const [isProjectCreateModalOpen, setProjectCreateModalOpen] = useState(false);
  const [workspaceModalState, setWorkspaceModalState] = useState<WorkspaceModalState>({
    isOpen: false,
    projectPath: null,
    projectName: "",
    branches: [],
    defaultTrunkBranch: undefined,
    loadErrorMessage: null,
    isLoading: false,
  });
  const workspaceModalProjectRef = useRef<string | null>(null);

  const refreshProjects = useCallback(async () => {
    if (!api) return;
    try {
      const projectsList = await api.projects.list();
      setProjects(new Map(projectsList));
    } catch (error) {
      console.error("Failed to load projects:", error);
      setProjects(new Map());
    }
  }, [api]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const addProject = useCallback((normalizedPath: string, projectConfig: ProjectConfig) => {
    setProjects((prev) => {
      const next = new Map(prev);
      next.set(normalizedPath, projectConfig);
      return next;
    });
  }, []);

  const removeProject = useCallback(
    async (path: string) => {
      if (!api) return;
      try {
        const result = await api.projects.remove({ projectPath: path });
        if (result.success) {
          setProjects((prev) => {
            const next = new Map(prev);
            next.delete(path);
            return next;
          });
        } else {
          console.error("Failed to remove project:", result.error);
        }
      } catch (error) {
        console.error("Failed to remove project:", error);
      }
    },
    [api]
  );

  const getBranchesForProject = useCallback(
    async (projectPath: string): Promise<BranchListResult> => {
      if (!api) {
        return { branches: [], recommendedTrunk: "" };
      }
      const branchResult = await api.projects.listBranches({ projectPath });
      const branches = branchResult.branches;
      const sanitizedBranches = Array.isArray(branches)
        ? branches.filter((branch): branch is string => typeof branch === "string")
        : [];

      const recommended =
        typeof branchResult?.recommendedTrunk === "string" &&
        sanitizedBranches.includes(branchResult.recommendedTrunk)
          ? branchResult.recommendedTrunk
          : (sanitizedBranches[0] ?? "");

      return {
        branches: sanitizedBranches,
        recommendedTrunk: recommended,
      };
    },
    [api]
  );

  const openWorkspaceModal = useCallback(
    async (projectPath: string, options?: { projectName?: string }) => {
      const projectName = options?.projectName ?? deriveProjectName(projectPath);
      workspaceModalProjectRef.current = projectPath;
      setWorkspaceModalState((prev) => ({
        ...prev,
        isOpen: true,
        projectPath,
        projectName,
        branches: [],
        defaultTrunkBranch: undefined,
        loadErrorMessage: null,
        isLoading: true,
      }));

      try {
        const { branches, recommendedTrunk } = await getBranchesForProject(projectPath);
        if (workspaceModalProjectRef.current !== projectPath) {
          return;
        }
        setWorkspaceModalState((prev) => ({
          ...prev,
          branches,
          defaultTrunkBranch: recommendedTrunk,
          loadErrorMessage: null,
          isLoading: false,
        }));
      } catch (error) {
        console.error("Failed to load branches for project:", error);
        if (workspaceModalProjectRef.current !== projectPath) {
          return;
        }
        const errorMessage =
          error instanceof Error ? error.message : "Failed to load branches for project";
        setWorkspaceModalState((prev) => ({
          ...prev,
          branches: [],
          defaultTrunkBranch: undefined,
          loadErrorMessage: errorMessage,
          isLoading: false,
        }));
      }
    },
    [getBranchesForProject]
  );

  const closeWorkspaceModal = useCallback(() => {
    workspaceModalProjectRef.current = null;
    setWorkspaceModalState({
      isOpen: false,
      projectPath: null,
      projectName: "",
      branches: [],
      defaultTrunkBranch: undefined,
      loadErrorMessage: null,
      isLoading: false,
    });
  }, []);

  const getSecrets = useCallback(
    async (projectPath: string): Promise<Secret[]> => {
      if (!api) return [];
      return await api.projects.secrets.get({ projectPath });
    },
    [api]
  );

  const updateSecrets = useCallback(
    async (projectPath: string, secrets: Secret[]) => {
      if (!api) return;
      const result = await api.projects.secrets.update({ projectPath, secrets });
      if (!result.success) {
        console.error("Failed to update secrets:", result.error);
      }
    },
    [api]
  );

  const value = useMemo<ProjectContext>(
    () => ({
      projects,
      refreshProjects,
      addProject,
      removeProject,
      isProjectCreateModalOpen,
      openProjectCreateModal: () => setProjectCreateModalOpen(true),
      closeProjectCreateModal: () => setProjectCreateModalOpen(false),
      workspaceModalState,
      openWorkspaceModal,
      closeWorkspaceModal,
      getBranchesForProject,
      getSecrets,
      updateSecrets,
    }),
    [
      projects,
      refreshProjects,
      addProject,
      removeProject,
      isProjectCreateModalOpen,
      workspaceModalState,
      openWorkspaceModal,
      closeWorkspaceModal,
      getBranchesForProject,
      getSecrets,
      updateSecrets,
    ]
  );

  return <ProjectContext.Provider value={value}>{props.children}</ProjectContext.Provider>;
}

export function useProjectContext(): ProjectContext {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error("useProjectContext must be used within ProjectProvider");
  }
  return context;
}
