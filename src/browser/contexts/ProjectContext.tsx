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
import type { ProjectConfig, SectionConfig } from "@/common/types/project";
import type { BranchListResult } from "@/common/orpc/types";
import type { Secret } from "@/common/types/secrets";
import type { Result } from "@/common/types/result";

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
  /** True while initial project list is loading */
  loading: boolean;
  refreshProjects: () => Promise<void>;
  addProject: (normalizedPath: string, projectConfig: ProjectConfig) => void;
  removeProject: (path: string) => Promise<{ success: boolean; error?: string }>;

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

  // Section operations
  createSection: (
    projectPath: string,
    name: string,
    color?: string
  ) => Promise<Result<SectionConfig>>;
  updateSection: (
    projectPath: string,
    sectionId: string,
    updates: { name?: string; color?: string }
  ) => Promise<Result<void>>;
  removeSection: (projectPath: string, sectionId: string) => Promise<Result<void>>;
  reorderSections: (projectPath: string, sectionIds: string[]) => Promise<Result<void>>;
  assignWorkspaceToSection: (
    projectPath: string,
    workspaceId: string,
    sectionId: string | null
  ) => Promise<Result<void>>;
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
  const [loading, setLoading] = useState(true);
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
    void (async () => {
      await refreshProjects();
      setLoading(false);
    })();
  }, [refreshProjects]);

  const addProject = useCallback((normalizedPath: string, projectConfig: ProjectConfig) => {
    setProjects((prev) => {
      const next = new Map(prev);
      next.set(normalizedPath, projectConfig);
      return next;
    });
  }, []);

  const removeProject = useCallback(
    async (path: string): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        const result = await api.projects.remove({ projectPath: path });
        if (result.success) {
          setProjects((prev) => {
            const next = new Map(prev);
            next.delete(path);
            return next;
          });
          return { success: true };
        } else {
          console.error("Failed to remove project:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to remove project:", errorMessage);
        return { success: false, error: errorMessage };
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
          defaultTrunkBranch: recommendedTrunk ?? undefined,
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

  // Section operations
  const createSection = useCallback(
    async (projectPath: string, name: string, color?: string): Promise<Result<SectionConfig>> => {
      if (!api) return { success: false, error: "API not connected" };
      const result = await api.projects.sections.create({ projectPath, name, color });
      if (result.success) {
        await refreshProjects();
      }
      return result;
    },
    [api, refreshProjects]
  );

  const updateSection = useCallback(
    async (
      projectPath: string,
      sectionId: string,
      updates: { name?: string; color?: string }
    ): Promise<Result<void>> => {
      if (!api) return { success: false, error: "API not connected" };
      const result = await api.projects.sections.update({ projectPath, sectionId, ...updates });
      if (result.success) {
        await refreshProjects();
      }
      return result;
    },
    [api, refreshProjects]
  );

  const removeSection = useCallback(
    async (projectPath: string, sectionId: string): Promise<Result<void>> => {
      if (!api) return { success: false, error: "API not connected" };
      const result = await api.projects.sections.remove({ projectPath, sectionId });
      if (result.success) {
        await refreshProjects();
      }
      return result;
    },
    [api, refreshProjects]
  );

  const reorderSections = useCallback(
    async (projectPath: string, sectionIds: string[]): Promise<Result<void>> => {
      if (!api) return { success: false, error: "API not connected" };
      const result = await api.projects.sections.reorder({ projectPath, sectionIds });
      if (result.success) {
        await refreshProjects();
      }
      return result;
    },
    [api, refreshProjects]
  );

  const assignWorkspaceToSection = useCallback(
    async (
      projectPath: string,
      workspaceId: string,
      sectionId: string | null
    ): Promise<Result<void>> => {
      if (!api) return { success: false, error: "API not connected" };
      const result = await api.projects.sections.assignWorkspace({
        projectPath,
        workspaceId,
        sectionId,
      });
      if (result.success) {
        await refreshProjects();
      }
      return result;
    },
    [api, refreshProjects]
  );

  const value = useMemo<ProjectContext>(
    () => ({
      projects,
      loading,
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
      createSection,
      updateSection,
      removeSection,
      reorderSections,
      assignWorkspaceToSection,
    }),
    [
      projects,
      loading,
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
      createSection,
      updateSection,
      removeSection,
      reorderSections,
      assignWorkspaceToSection,
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
