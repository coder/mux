export const TASK_GROUP_KIND_VALUES = ["bestOf", "variants"] as const;

export const TASK_GROUP_KIND = {
  BEST_OF: "bestOf",
  VARIANTS: "variants",
} as const;

export type TaskGroupKind = (typeof TASK_GROUP_KIND_VALUES)[number];

export const TASK_VARIANT_PLACEHOLDER = "${variant}";

export interface TaskGroupArgsLike {
  n?: number | null;
  variants?: readonly string[] | null;
}

export interface TaskGroupMetadataLike {
  kind?: TaskGroupKind | null;
  label?: string | null;
}

export interface TaskGroupLaunchArgs extends TaskGroupArgsLike {
  prompt: string;
}

export interface TaskGroupLaunchDescriptor {
  index: number;
  total: number;
  kind: TaskGroupKind;
  label?: string;
  prompt: string;
}

export function normalizeTaskGroupKind(kind: TaskGroupKind | null | undefined): TaskGroupKind {
  return kind === TASK_GROUP_KIND.VARIANTS ? TASK_GROUP_KIND.VARIANTS : TASK_GROUP_KIND.BEST_OF;
}

export function normalizeTaskGroupLabel(label: string | null | undefined): string | undefined {
  const trimmedLabel = label?.trim();
  if (!trimmedLabel) {
    return undefined;
  }
  return trimmedLabel;
}

export function getTaskGroupCount(args: TaskGroupArgsLike | null | undefined): number {
  if (Array.isArray(args?.variants) && args.variants.length > 0) {
    return args.variants.length;
  }
  return args?.n ?? 1;
}

export function getTaskGroupLabelAtIndex(
  args: TaskGroupArgsLike | null | undefined,
  index: number
): string | undefined {
  const variants = args?.variants;
  if (!variants || index < 0 || index >= variants.length) {
    return undefined;
  }
  return normalizeTaskGroupLabel(variants[index]);
}

export function getTaskGroupKindFromArgs(
  args: TaskGroupArgsLike | null | undefined
): TaskGroupKind {
  return Array.isArray(args?.variants) && args.variants.length > 0
    ? TASK_GROUP_KIND.VARIANTS
    : TASK_GROUP_KIND.BEST_OF;
}

export function getTaskGroupKindFromMetadata(
  metadata: TaskGroupMetadataLike | null | undefined
): TaskGroupKind {
  return normalizeTaskGroupKind(metadata?.kind);
}

export function replaceTaskVariantPlaceholder(prompt: string, variant: string): string {
  return prompt.split(TASK_VARIANT_PLACEHOLDER).join(variant);
}

export function buildTaskGroupLaunches(args: TaskGroupLaunchArgs): TaskGroupLaunchDescriptor[] {
  const variants = args.variants ?? [];
  if (variants.length > 0) {
    return variants.map((variant, index) => ({
      index,
      total: variants.length,
      kind: TASK_GROUP_KIND.VARIANTS,
      label: variant,
      prompt: replaceTaskVariantPlaceholder(args.prompt, variant),
    }));
  }

  const total = getTaskGroupCount(args);
  return Array.from({ length: total }, (_, index) => ({
    index,
    total,
    kind: TASK_GROUP_KIND.BEST_OF,
    prompt: args.prompt,
  }));
}

export function formatTaskGroupSummary(kind: TaskGroupKind, total: number): string {
  return kind === TASK_GROUP_KIND.VARIANTS ? "Variants" : `Best of ${total}`;
}

export function formatTaskGroupHeader(kind: TaskGroupKind, total: number, title: string): string {
  return `${formatTaskGroupSummary(kind, total)} · ${title}`;
}

export function formatTaskGroupItemsLabel(kind: TaskGroupKind): string {
  return kind === TASK_GROUP_KIND.VARIANTS ? "Variants" : "Candidates";
}

export function formatTaskGroupCreationLabel(kind: TaskGroupKind): string {
  return kind === TASK_GROUP_KIND.VARIANTS ? "Creating variants" : "Creating candidates";
}

export function formatTaskGroupMemberLabel(params: {
  kind: TaskGroupKind;
  index: number;
  label?: string | null;
}): string {
  const normalizedLabel = normalizeTaskGroupLabel(params.label);
  if (params.kind === TASK_GROUP_KIND.VARIANTS && normalizedLabel) {
    return normalizedLabel;
  }
  return `candidate ${params.index + 1}`;
}
