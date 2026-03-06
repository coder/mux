import type { ProjectConfig, WorkingDirectoryConfig } from "@/common/types/project";

export interface EditableWorkingDirectoryInput {
  id?: string;
  path: string;
}

export interface EditableProjectMetadataDraft {
  name: string;
  systemPrompt: string;
  workingDirectories: EditableWorkingDirectoryInput[];
}

export interface ProjectCreateEditableMetadataInput {
  name?: string;
  systemPrompt?: string;
  workingDirectories?: EditableWorkingDirectoryInput[];
}

export interface ProjectUpdateEditableMetadataInput {
  projectPath: string;
  projectId?: string;
  name?: string;
  systemPrompt: string | null;
  workingDirectories: EditableWorkingDirectoryInput[];
}

function toTrimmedNonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

export function normalizeEditableWorkingDirectories(
  workingDirectories: ReadonlyArray<EditableWorkingDirectoryInput>
): EditableWorkingDirectoryInput[] {
  const normalizedWorkingDirectories: EditableWorkingDirectoryInput[] = [];

  for (const workingDirectory of workingDirectories) {
    const normalizedPath = toTrimmedNonEmpty(workingDirectory.path);
    if (!normalizedPath) {
      continue;
    }

    const normalizedId = toTrimmedNonEmpty(workingDirectory.id);
    if (normalizedId) {
      normalizedWorkingDirectories.push({
        id: normalizedId,
        path: normalizedPath,
      });
      continue;
    }

    normalizedWorkingDirectories.push({
      path: normalizedPath,
    });
  }

  return normalizedWorkingDirectories;
}

function getNonRootWorkingDirectories(
  projectPath: string,
  workingDirectories: ReadonlyArray<WorkingDirectoryConfig> | undefined
): EditableWorkingDirectoryInput[] {
  if (!Array.isArray(workingDirectories)) {
    return [];
  }

  return workingDirectories
    .filter((workingDirectory) => workingDirectory.path !== projectPath)
    .map((workingDirectory) => ({
      id: workingDirectory.id,
      path: workingDirectory.path,
    }));
}

export function projectConfigToEditableMetadataDraft(
  projectPath: string,
  projectConfig: ProjectConfig | undefined
): EditableProjectMetadataDraft {
  return {
    name: projectConfig?.name ?? "",
    systemPrompt: projectConfig?.systemPrompt ?? "",
    workingDirectories: getNonRootWorkingDirectories(
      projectPath,
      projectConfig?.workingDirectories
    ),
  };
}

export function buildProjectCreateEditableMetadataInput(
  draft: EditableProjectMetadataDraft
): ProjectCreateEditableMetadataInput {
  const normalizedName = toTrimmedNonEmpty(draft.name);
  const normalizedSystemPrompt = toTrimmedNonEmpty(draft.systemPrompt);
  const normalizedWorkingDirectories = normalizeEditableWorkingDirectories(
    draft.workingDirectories
  );

  return {
    ...(normalizedName ? { name: normalizedName } : {}),
    ...(normalizedSystemPrompt ? { systemPrompt: normalizedSystemPrompt } : {}),
    ...(normalizedWorkingDirectories.length > 0
      ? { workingDirectories: normalizedWorkingDirectories }
      : {}),
  };
}

export function buildProjectUpdateEditableMetadataInput(params: {
  projectPath: string;
  projectId?: string;
  draft: EditableProjectMetadataDraft;
}): ProjectUpdateEditableMetadataInput {
  const normalizedProjectId = toTrimmedNonEmpty(params.projectId);
  const normalizedName = toTrimmedNonEmpty(params.draft.name);
  const normalizedSystemPrompt = toTrimmedNonEmpty(params.draft.systemPrompt);

  return {
    projectPath: params.projectPath,
    ...(normalizedProjectId ? { projectId: normalizedProjectId } : {}),
    ...(normalizedName ? { name: normalizedName } : {}),
    systemPrompt: normalizedSystemPrompt ?? null,
    workingDirectories: normalizeEditableWorkingDirectories(params.draft.workingDirectories),
  };
}
