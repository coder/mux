/**
 * Storybook stories for agent_skill_read + agent_skill_read_file tool UIs.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import { setupSimpleChatStory } from "./storyHelpers";
import {
  STABLE_TIMESTAMP,
  createAssistantMessage,
  createGenericTool,
  createUserMessage,
} from "./mockFactory";
import {
  blurActiveElement,
  waitForChatInputAutofocusDone,
  waitForChatMessagesLoaded,
  waitForScrollStabilization,
} from "./storyPlayHelpers";
import { userEvent, waitFor } from "@storybook/test";

export default {
  ...appMeta,
  title: "App/Agent Skill Tools",
};

async function expandFirstToolCall(canvasElement: HTMLElement) {
  await waitForChatMessagesLoaded(canvasElement);

  const messageWindow = canvasElement.querySelector('[data-testid="message-window"]');
  if (!(messageWindow instanceof HTMLElement)) {
    throw new Error("Message window not found");
  }

  await waitFor(
    () => {
      const allSpans = messageWindow.querySelectorAll("span");
      const expandIcon = Array.from(allSpans).find((span) => span.textContent?.trim() === "▶");
      if (!expandIcon) {
        throw new Error("No expand icon found");
      }
    },
    { timeout: 5000 }
  );

  const allSpans = messageWindow.querySelectorAll("span");
  const expandIcon = Array.from(allSpans).find((span) => span.textContent?.trim() === "▶");
  if (!expandIcon) {
    throw new Error("No expand icon found");
  }

  const header = expandIcon.closest("div.cursor-pointer");
  if (!(header instanceof HTMLElement)) {
    throw new Error("Tool header not found");
  }

  await userEvent.click(header);

  // Give ResizeObserver-based scroll a chance to settle after expansion.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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

/** Shows the SkillIndicator popover with all skill scopes (project, global, built-in) */
export const SkillIndicator_AllScopes: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-skill-indicator",
          messages: [],
          agentSkills: ALL_SKILLS,
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForChatMessagesLoaded(canvasElement);

    // Find the skill indicator button by its aria-label
    const doc = canvasElement.ownerDocument;
    const storyRoot = doc.getElementById("storybook-root") ?? canvasElement;
    await waitFor(
      () => {
        const skillButton = storyRoot.querySelector('button[aria-label*="skill"]');
        if (!skillButton) throw new Error("Skill indicator not found");
      },
      { timeout: 5000 }
    );

    const skillButton = storyRoot.querySelector('button[aria-label*="skill"]')!;
    await userEvent.hover(skillButton);

    // Wait for popover to appear (hover triggers open)
    await waitFor(
      () => {
        const popover = doc.querySelector("[data-radix-popper-content-wrapper]");
        if (!popover) throw new Error("Popover not visible");
      },
      { timeout: 3000 }
    );

    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};

/** Shows unadvertised skills (advertise: false) with EyeOff icon in the popover */
export const SkillIndicator_UnadvertisedSkills: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-skill-indicator-unadvertised",
          messages: [],
          agentSkills: SKILLS_WITH_UNADVERTISED,
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForChatMessagesLoaded(canvasElement);

    const doc = canvasElement.ownerDocument;
    const storyRoot = doc.getElementById("storybook-root") ?? canvasElement;
    await waitFor(
      () => {
        const skillButton = storyRoot.querySelector('button[aria-label*="skill"]');
        if (!skillButton) throw new Error("Skill indicator not found");
      },
      { timeout: 5000 }
    );

    const skillButton = storyRoot.querySelector('button[aria-label*="skill"]')!;
    await userEvent.hover(skillButton);

    // Wait for popover to appear with EyeOff icons for unadvertised skills
    await waitFor(
      () => {
        const popover = doc.querySelector("[data-radix-popper-content-wrapper]");
        if (!popover) throw new Error("Popover not visible");
        // Verify EyeOff icon is present (aria-label for unadvertised skills)
        const eyeOffIcon = popover.querySelector('[aria-label="Not advertised in system prompt"]');
        if (!eyeOffIcon) throw new Error("EyeOff icon not found for unadvertised skill");
      },
      { timeout: 3000 }
    );

    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SKILL TOOL CALLS
// ═══════════════════════════════════════════════════════════════════════════════

export const AgentSkillRead_Collapsed: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-agent-skill-read-collapsed",
          messages: [
            createUserMessage("u1", "Load the react-effects skill", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("a1", "Reading skill:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 59000,
              toolCalls: [
                createGenericTool(
                  "tc1",
                  "agent_skill_read",
                  { name: "react-effects" },
                  { success: true, skill: SKILL_PACKAGE }
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);
    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};

export const AgentSkillRead_Expanded: AppStory = {
  render: AgentSkillRead_Collapsed.render,
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);
    await expandFirstToolCall(canvasElement);
    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};

export const AgentSkillReadFile_Collapsed: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-agent-skill-file-collapsed",
          messages: [
            createUserMessage("u1", "Read a file from the skill", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("a1", "Reading file:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 59000,
              toolCalls: [
                createGenericTool(
                  "tc1",
                  "agent_skill_read_file",
                  { name: "react-effects", filePath: "references/README.md", offset: 1, limit: 5 },
                  {
                    success: true,
                    file_size: 250,
                    modifiedTime: "2023-11-14T00:00:00.000Z",
                    lines_read: 5,
                    content: SKILL_FILE_CONTENT,
                  }
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);
    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};

export const AgentSkillReadFile_Expanded: AppStory = {
  render: AgentSkillReadFile_Collapsed.render,
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);
    await expandFirstToolCall(canvasElement);
    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};
