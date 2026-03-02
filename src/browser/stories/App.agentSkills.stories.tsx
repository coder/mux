/**
 * Storybook stories for agent_skill_read + agent_skill_read_file tool UIs.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor } from "@storybook/test";
import { SkillIndicator } from "@/browser/components/SkillIndicator/SkillIndicator";
import { AgentSkillReadToolCall as AgentSkillReadToolCallCard } from "@/browser/features/Tools/AgentSkillReadToolCall";
import { AgentSkillReadFileToolCall as AgentSkillReadFileToolCallCard } from "@/browser/features/Tools/AgentSkillReadFileToolCall";
import type { SkillLoadError } from "@/browser/utils/messages/StreamingMessageAggregator";
import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";
import { lightweightMeta } from "./meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Agent Skill Tools",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

async function openSkillIndicatorPopover(canvasElement: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    const skillButton = canvasElement.querySelector('button[aria-label*="skill"]');
    if (!(skillButton instanceof HTMLElement)) {
      throw new Error("Skill indicator not found");
    }
  });

  const skillButton = canvasElement.querySelector('button[aria-label*="skill"]');
  if (!(skillButton instanceof HTMLElement)) {
    throw new Error("Skill indicator not found");
  }

  await userEvent.hover(skillButton);

  const doc = canvasElement.ownerDocument;
  await waitFor(() => {
    const popover = doc.querySelector("[data-radix-popper-content-wrapper]");
    if (!(popover instanceof HTMLElement)) {
      throw new Error("Popover not visible");
    }
  });

  const popover = doc.querySelector("[data-radix-popper-content-wrapper]");
  if (!(popover instanceof HTMLElement)) {
    throw new Error("Popover not visible");
  }

  return popover;
}

async function expandFirstToolCall(canvasElement: HTMLElement): Promise<void> {
  await waitFor(() => {
    const header = canvasElement.querySelector("div.cursor-pointer");
    if (!(header instanceof HTMLElement)) {
      throw new Error("Tool header not found");
    }
  });

  const header = canvasElement.querySelector("div.cursor-pointer");
  if (!(header instanceof HTMLElement)) {
    throw new Error("Tool header not found");
  }

  await userEvent.click(header);
}

const SKILL_PACKAGE = {
  scope: "project",
  directoryName: "react-effects",
  frontmatter: {
    name: "react-effects",
    description: "Guidelines for when to use (and avoid) useEffect in React components",
    license: "MIT",
    compatibility: "Mux desktop app",
    metadata: {
      owner: "mux",
      audience: "contributors",
    },
  },
  body: `## useEffect: last resort

Effects run after paint. Prefer derived state and event handlers.

### Prefer

- Derive values during render
- Use explicit event handlers

### Avoid

- Syncing props to state via effects
- Timing-based coordination

<details>
<summary>Why this matters</summary>

Effects can introduce UI flicker and race conditions.

</details>`,
};

const SKILL_FILE_CONTENT = [
  "1\t# references/README.md",
  "2\t",
  "3\tThis file lives inside the skill directory.",
  "4\t- It can contain examples.",
  "5\t- It can contain references.",
].join("\n");

// ═══════════════════════════════════════════════════════════════════════════════
// SKILL INDICATOR (hover tooltip showing available skills)
// ═══════════════════════════════════════════════════════════════════════════════

const ALL_SKILLS: AgentSkillDescriptor[] = [
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
    name: "api-client",
    description: "Shared API client configuration and auth helpers",
    scope: "global",
  },
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

const LOADED_ALL_SCOPES = ALL_SKILLS.filter((skill) => {
  return skill.name === "pull-requests" || skill.name === "api-client" || skill.name === "init";
});

const SKILLS_WITH_UNADVERTISED: AgentSkillDescriptor[] = [
  {
    name: "pull-requests",
    description: "Guidelines for creating and managing Pull Requests in this repo",
    scope: "project",
  },
  {
    name: "deep-review",
    description: "Sub-agent powered code reviews spanning correctness, tests, consistency, and fit",
    scope: "project",
    advertise: false,
  },
  {
    name: "internal-debug",
    description: "Internal debugging utilities (not advertised in system prompt)",
    scope: "global",
    advertise: false,
  },
  {
    name: "init",
    description: "Bootstrap an AGENTS.md file in a new or existing project",
    scope: "built-in",
  },
];

const LOADED_UNADVERTISED = SKILLS_WITH_UNADVERTISED.filter((skill) => {
  return skill.name === "pull-requests" || skill.name === "deep-review";
});

const INVALID_SKILLS: AgentSkillIssue[] = [
  {
    directoryName: "Bad_Skill",
    scope: "project",
    displayPath: "/home/user/projects/my-app/.mux/skills/Bad_Skill/SKILL.md",
    message: "Invalid skill directory name (expected kebab-case).",
    hint: "Rename the directory to something like bad-skill.",
  },
  {
    directoryName: "missing-skill",
    scope: "global",
    displayPath: "/home/user/.mux/skills/missing-skill/SKILL.md",
    message: "SKILL.md is missing.",
    hint: "Add a SKILL.md with valid frontmatter (name + description).",
  },
];

const SKILL_LOAD_ERRORS: SkillLoadError[] = [
  { name: "deployment", error: "Agent skill not found: deployment" },
  {
    name: "staging-env",
    error: "Failed to read SKILL.md: Permission denied (os error 13)",
  },
];

function renderSkillIndicatorStory(props: {
  loadedSkills: AgentSkillDescriptor[];
  availableSkills: AgentSkillDescriptor[];
  invalidSkills?: AgentSkillIssue[];
  skillLoadErrors?: SkillLoadError[];
}) {
  return (
    <div className="bg-background flex min-h-[220px] items-start justify-end p-6">
      <SkillIndicator
        loadedSkills={props.loadedSkills}
        availableSkills={props.availableSkills}
        invalidSkills={props.invalidSkills}
        skillLoadErrors={props.skillLoadErrors}
      />
    </div>
  );
}

/** Shows the SkillIndicator popover with all skill scopes (project, global, built-in) */
export const SkillIndicator_AllScopes: Story = {
  render: () =>
    renderSkillIndicatorStory({
      loadedSkills: LOADED_ALL_SCOPES,
      availableSkills: ALL_SKILLS,
    }),
  play: async ({ canvasElement }) => {
    const popover = await openSkillIndicatorPopover(canvasElement);

    await waitFor(() => {
      const text = popover.textContent ?? "";
      if (!text.includes("Project skills")) throw new Error("Project scope section not visible");
      if (!text.includes("Global skills")) throw new Error("Global scope section not visible");
      if (!text.includes("Built-in skills")) throw new Error("Built-in scope section not visible");
    });
  },
};

/** Shows unadvertised skills (advertise: false) with EyeOff icon in the popover */
export const SkillIndicator_UnadvertisedSkills: Story = {
  render: () =>
    renderSkillIndicatorStory({
      loadedSkills: LOADED_UNADVERTISED,
      availableSkills: SKILLS_WITH_UNADVERTISED,
    }),
  play: async ({ canvasElement }) => {
    const popover = await openSkillIndicatorPopover(canvasElement);

    await waitFor(() => {
      const eyeOffIcon = popover.querySelector('[aria-label="Not advertised in system prompt"]');
      if (!eyeOffIcon) throw new Error("EyeOff icon not found for unadvertised skill");
    });
  },
};

/** Shows invalid skills in the SkillIndicator popover ("Invalid skills" section) */
export const SkillIndicator_InvalidSkills: Story = {
  render: () =>
    renderSkillIndicatorStory({
      loadedSkills: LOADED_ALL_SCOPES,
      availableSkills: ALL_SKILLS,
      invalidSkills: INVALID_SKILLS,
    }),
  play: async ({ canvasElement }) => {
    const popover = await openSkillIndicatorPopover(canvasElement);

    await waitFor(() => {
      const text = popover.textContent ?? "";
      if (!text.includes("Invalid skills")) {
        throw new Error("Invalid skills section not visible");
      }
      if (!text.includes("Bad_Skill")) {
        throw new Error("Invalid skill name not visible");
      }
    });
  },
};

/** Shows runtime skill load errors in the SkillIndicator popover ("Load errors" section) */
export const SkillIndicator_LoadErrors: Story = {
  render: () =>
    renderSkillIndicatorStory({
      loadedSkills: LOADED_ALL_SCOPES,
      availableSkills: ALL_SKILLS,
      skillLoadErrors: SKILL_LOAD_ERRORS,
    }),
  play: async ({ canvasElement }) => {
    const popover = await openSkillIndicatorPopover(canvasElement);

    await waitFor(() => {
      const text = popover.textContent ?? "";
      if (!text.includes("Load errors")) {
        throw new Error("Load errors section not visible");
      }
      if (!text.includes("deployment")) {
        throw new Error("Failed skill name not visible");
      }
    });
  },
};

/** Shows both invalid skills and runtime load errors together in the popover */
export const SkillIndicator_AllErrors: Story = {
  render: () =>
    renderSkillIndicatorStory({
      loadedSkills: LOADED_ALL_SCOPES,
      availableSkills: ALL_SKILLS,
      invalidSkills: INVALID_SKILLS,
      skillLoadErrors: SKILL_LOAD_ERRORS,
    }),
  play: async ({ canvasElement }) => {
    const popover = await openSkillIndicatorPopover(canvasElement);

    await waitFor(() => {
      const text = popover.textContent ?? "";
      if (!text.includes("Invalid skills")) {
        throw new Error("Invalid skills section not visible");
      }
      if (!text.includes("Load errors")) {
        throw new Error("Load errors section not visible");
      }
    });
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SKILL TOOL CALLS
// ═══════════════════════════════════════════════════════════════════════════════

function renderAgentSkillReadToolCall() {
  return (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-2xl">
        <AgentSkillReadToolCallCard
          args={{ name: "react-effects" }}
          result={{ success: true, skill: SKILL_PACKAGE }}
          status="completed"
        />
      </div>
    </div>
  );
}

function renderAgentSkillReadFileToolCall() {
  return (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-2xl">
        <AgentSkillReadFileToolCallCard
          args={{ name: "react-effects", filePath: "references/README.md", offset: 1, limit: 5 }}
          result={{
            success: true,
            file_size: 250,
            modifiedTime: "2023-11-14T00:00:00.000Z",
            lines_read: 5,
            content: SKILL_FILE_CONTENT,
          }}
          status="completed"
        />
      </div>
    </div>
  );
}

export const AgentSkillRead_Collapsed: Story = {
  render: renderAgentSkillReadToolCall,
};

export const AgentSkillRead_Expanded: Story = {
  render: renderAgentSkillReadToolCall,
  play: async ({ canvasElement }) => {
    await expandFirstToolCall(canvasElement);

    await waitFor(() => {
      if (!canvasElement.textContent?.includes("Contents")) {
        throw new Error("Expanded skill contents are not visible");
      }
    });
  },
};

export const AgentSkillReadFile_Collapsed: Story = {
  render: renderAgentSkillReadFileToolCall,
};

export const AgentSkillReadFile_Expanded: Story = {
  render: renderAgentSkillReadFileToolCall,
  play: async ({ canvasElement }) => {
    await expandFirstToolCall(canvasElement);

    await waitFor(() => {
      if (!canvasElement.textContent?.includes("Content")) {
        throw new Error("Expanded file contents are not visible");
      }
    });
  },
};
