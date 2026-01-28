/**
 * Storybook stories for the SkillIndicator tooltip component.
 *
 * Tests the skill tooltip display including hidden skills with EyeOff icon.
 */

import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import { SkillIndicator } from "../components/SkillIndicator";
import { TooltipProvider } from "../components/ui/tooltip";
import type { Meta, StoryFn } from "@storybook/react-vite";

// ═══════════════════════════════════════════════════════════════════════════════
// META CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const meta: Meta<typeof SkillIndicator> = {
  title: "Components/SkillIndicator",
  component: SkillIndicator,
  parameters: {
    layout: "centered",
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#1e1e1e" }],
    },
  },
  decorators: [
    (Story) => (
      <TooltipProvider delayDuration={0}>
        <div className="p-8">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
};

export default meta;

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK DATA
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_SKILLS: AgentSkillDescriptor[] = [
  {
    name: "pull-requests",
    description: "Guidelines for creating and managing Pull Requests in this repo",
    scope: "project",
  },
  {
    name: "tests",
    description: "Testing doctrine, commands, and test layout conventions",
    scope: "project",
  },
  {
    name: "master",
    description: "Orchestration mode that aggressively uses sub-agents for parallel exploration",
    scope: "project",
    hidden: true,
  },
];

const GLOBAL_SKILLS: AgentSkillDescriptor[] = [
  {
    name: "my-custom-skill",
    description: "A user-defined global skill available across all projects",
    scope: "global",
  },
];

const BUILTIN_SKILLS: AgentSkillDescriptor[] = [
  {
    name: "init",
    description: "Bootstrap an AGENTS.md file in a new or existing project",
    scope: "built-in",
  },
  {
    name: "mux-docs",
    description: "Index + offline snapshot of mux documentation (progressive disclosure)",
    scope: "built-in",
  },
];

const ALL_SKILLS = [...PROJECT_SKILLS, ...GLOBAL_SKILLS, ...BUILTIN_SKILLS];

// ═══════════════════════════════════════════════════════════════════════════════
// STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** No skills loaded - shows all available skills in muted state */
export const NoSkillsLoaded: StoryFn<typeof SkillIndicator> = () => (
  <SkillIndicator loadedSkills={[]} availableSkills={ALL_SKILLS} />
);

/** Some skills loaded - shows loaded with checkmark, includes hidden skill with EyeOff */
export const SomeSkillsLoaded: StoryFn<typeof SkillIndicator> = () => (
  <SkillIndicator
    loadedSkills={[PROJECT_SKILLS[0], PROJECT_SKILLS[1]]}
    availableSkills={ALL_SKILLS}
  />
);

/** Hidden skill loaded - shows EyeOff icon alongside checkmark */
export const HiddenSkillLoaded: StoryFn<typeof SkillIndicator> = () => (
  <SkillIndicator
    loadedSkills={[PROJECT_SKILLS[2], PROJECT_SKILLS[0]]}
    availableSkills={ALL_SKILLS}
  />
);

/** All skills loaded */
export const AllSkillsLoaded: StoryFn<typeof SkillIndicator> = () => (
  <SkillIndicator loadedSkills={ALL_SKILLS} availableSkills={ALL_SKILLS} />
);

/** Only project skills */
export const ProjectSkillsOnly: StoryFn<typeof SkillIndicator> = () => (
  <SkillIndicator loadedSkills={[PROJECT_SKILLS[1]]} availableSkills={PROJECT_SKILLS} />
);

/** Multiple hidden skills */
export const MultipleHiddenSkills: StoryFn<typeof SkillIndicator> = () => (
  <SkillIndicator
    loadedSkills={[]}
    availableSkills={[
      ...PROJECT_SKILLS,
      {
        name: "internal-debug",
        description: "Internal debugging utilities (hidden from system prompt)",
        scope: "project",
        hidden: true,
      },
      {
        name: "orchestrator",
        description: "Advanced orchestration patterns for complex workflows",
        scope: "global",
        hidden: true,
      },
      ...BUILTIN_SKILLS,
    ]}
  />
);
