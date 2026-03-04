import type { SectionRuleCondition } from "@/common/schemas/project";

export interface RuleFieldOption {
  label: string;
  value: string | boolean;
}

export interface RuleFieldMeta {
  label: string;
  type: "string" | "boolean";
  /** Available options for the condition value picker. */
  options?: RuleFieldOption[];
}

const YES_NO_OPTIONS: RuleFieldOption[] = [
  { label: "Yes", value: true },
  { label: "No", value: false },
];

/**
 * Shared metadata for the section rule editor so browser and tests use one field contract.
 *
 * Keep this map exhaustive via Record<SectionRuleCondition["field"], ...> so adding new
 * rule fields in the schema fails loudly until UI metadata is updated.
 */
/**
 * NOTE: Rules that combine PR fields and git fields (e.g., prState == OPEN AND gitDirty == true)
 * may not evaluate correctly because PR and git status are sent from separate frontend stores.
 * Each store provides its own context independently. Mixed-field rules will only match when
 * both stores have sent context in the same evaluation cycle. This is a known v1 limitation.
 */
export const RULE_FIELD_META: Record<SectionRuleCondition["field"], RuleFieldMeta> = {
  agentMode: {
    label: "Agent mode",
    type: "string",
    options: [
      { label: "Plan", value: "plan" },
      { label: "Exec", value: "exec" },
      { label: "Code", value: "code" },
      { label: "Compact", value: "compact" },
      { label: "Auto", value: "auto" },
      { label: "Explore", value: "explore" },
      { label: "Ask", value: "ask" },
    ],
  },
  streaming: {
    label: "Streaming",
    type: "boolean",
    options: YES_NO_OPTIONS,
  },
  prState: {
    label: "PR state",
    type: "string",
    options: [
      { label: "Open", value: "OPEN" },
      { label: "Closed", value: "CLOSED" },
      { label: "Merged", value: "MERGED" },
      { label: "None", value: "none" },
    ],
  },
  prMergeStatus: {
    label: "PR merge status",
    type: "string",
    options: [
      { label: "Clean", value: "CLEAN" },
      { label: "Blocked", value: "BLOCKED" },
      { label: "Behind", value: "BEHIND" },
      { label: "Dirty", value: "DIRTY" },
      { label: "Unstable", value: "UNSTABLE" },
      { label: "Has hooks", value: "HAS_HOOKS" },
      { label: "Draft", value: "DRAFT" },
      { label: "Unknown", value: "UNKNOWN" },
    ],
  },
  prIsDraft: {
    label: "PR is draft",
    type: "boolean",
    options: YES_NO_OPTIONS,
  },
  prHasFailedChecks: {
    label: "PR has failed checks",
    type: "boolean",
    options: YES_NO_OPTIONS,
  },
  prHasPendingChecks: {
    label: "PR has pending checks",
    type: "boolean",
    options: YES_NO_OPTIONS,
  },
  taskStatus: {
    label: "Task status",
    type: "string",
    options: [
      { label: "Queued", value: "queued" },
      { label: "Running", value: "running" },
      { label: "Awaiting report", value: "awaiting_report" },
      { label: "Interrupted", value: "interrupted" },
      { label: "Reported", value: "reported" },
    ],
  },
  hasAgentStatus: {
    label: "Has agent status",
    type: "boolean",
    options: YES_NO_OPTIONS,
  },
  gitDirty: {
    label: "Git dirty",
    type: "boolean",
    options: YES_NO_OPTIONS,
  },
};

/** Ordered keys used by the field picker in SectionRuleEditor. */
export const RULE_FIELD_KEYS = Object.keys(RULE_FIELD_META) as Array<SectionRuleCondition["field"]>;
