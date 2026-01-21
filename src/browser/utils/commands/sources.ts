import { THEME_OPTIONS, type ThemeMode } from "@/browser/contexts/ThemeContext";
import type { CommandAction } from "@/browser/contexts/CommandRegistryContext";
import type { APIClient } from "@/browser/contexts/API";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { THINKING_LEVELS, type ThinkingLevel } from "@/common/types/thinking";
import assert from "@/common/utils/assert";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  getAutoRetryKey,
  getRightSidebarLayoutKey,
  RIGHT_SIDEBAR_TAB_KEY,
} from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { CommandIds } from "@/browser/utils/commandIds";
import { isTabType, type TabType } from "@/browser/types/rightSidebar";
import {
  getEffectiveSlotKeybind,
  getLayoutsConfigOrDefault,
  getPresetForSlot,
} from "@/browser/utils/uiLayouts";
import type { LayoutPresetsConfig, LayoutSlotNumber } from "@/common/types/uiLayouts";
import {
  addToolToFocusedTabset,
  getDefaultRightSidebarLayoutState,
  parseRightSidebarLayoutState,
  selectTabInTabset,
  setFocusedTabset,
  splitFocusedTabset,
} from "@/browser/utils/rightSidebarLayout";

import type { ProjectConfig } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { BranchListResult } from "@/common/orpc/types";
import type { WorkspaceState } from "@/browser/stores/WorkspaceStore";
import type { RuntimeConfig } from "@/common/types/runtime";

export interface BuildSourcesParams {
  api: APIClient | null;
  projects: Map<string, ProjectConfig>;
  /** Map of workspace ID to workspace metadata (keyed by metadata.id, not path) */
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>;
  theme: ThemeMode;
  selectedWorkspaceState?: WorkspaceState | null;
  selectedWorkspace: {
    projectPath: string;
    projectName: string;
    namedWorkspacePath: string;
    workspaceId: string;
  } | null;
  streamingModels?: Map<string, string>;
  // UI actions
  getThinkingLevel: (workspaceId: string) => ThinkingLevel;
  onSetThinkingLevel: (workspaceId: string, level: ThinkingLevel) => void;

  onStartWorkspaceCreation: (projectPath: string) => void;
  getBranchesForProject: (projectPath: string) => Promise<BranchListResult>;
  onSelectWorkspace: (sel: {
    projectPath: string;
    projectName: string;
    namedWorkspacePath: string;
    workspaceId: string;
  }) => void;
  onRemoveWorkspace: (workspaceId: string) => Promise<{ success: boolean; error?: string }>;
  onRenameWorkspace: (
    workspaceId: string,
    newName: string
  ) => Promise<{ success: boolean; error?: string }>;
  onAddProject: () => void;
  onRemoveProject: (path: string) => void;
  onToggleSidebar: () => void;
  onNavigateWorkspace: (dir: "next" | "prev") => void;
  onOpenWorkspaceInTerminal: (workspaceId: string, runtimeConfig?: RuntimeConfig) => void;
  onToggleTheme: () => void;
  onSetTheme: (theme: ThemeMode) => void;
  onOpenSettings?: (section?: string) => void;

  // Layout slots
  layoutPresets?: LayoutPresetsConfig | null;
  onApplyLayoutSlot?: (workspaceId: string, slot: LayoutSlotNumber) => void;
  onCaptureLayoutSlot?: (
    workspaceId: string,
    slot: LayoutSlotNumber,
    name: string
  ) => Promise<void>;
  onClearTimingStats?: (workspaceId: string) => void;
}

/**
 * Command palette section names
 * Exported for use in filtering and command organization
 */
export const COMMAND_SECTIONS = {
  WORKSPACES: "Workspaces",
  LAYOUTS: "Layouts",
  NAVIGATION: "Navigation",
  CHAT: "Chat",
  MODE: "Modes & Model",
  HELP: "Help",
  PROJECTS: "Projects",
  APPEARANCE: "Appearance",
  SETTINGS: "Settings",
} as const;

const section = {
  layouts: COMMAND_SECTIONS.LAYOUTS,
  workspaces: COMMAND_SECTIONS.WORKSPACES,
  navigation: COMMAND_SECTIONS.NAVIGATION,
  chat: COMMAND_SECTIONS.CHAT,
  appearance: COMMAND_SECTIONS.APPEARANCE,
  mode: COMMAND_SECTIONS.MODE,
  help: COMMAND_SECTIONS.HELP,
  projects: COMMAND_SECTIONS.PROJECTS,
  settings: COMMAND_SECTIONS.SETTINGS,
};

const getRightSidebarTabFallback = (): TabType => {
  const raw = readPersistedState<string>(RIGHT_SIDEBAR_TAB_KEY, "costs");
  return isTabType(raw) ? raw : "costs";
};

const updateRightSidebarLayout = (
  workspaceId: string,
  updater: (
    state: ReturnType<typeof parseRightSidebarLayoutState>
  ) => ReturnType<typeof parseRightSidebarLayoutState>
) => {
  const fallback = getRightSidebarTabFallback();
  const defaultLayout = getDefaultRightSidebarLayoutState(fallback);

  updatePersistedState<ReturnType<typeof parseRightSidebarLayoutState>>(
    getRightSidebarLayoutKey(workspaceId),
    (prev) => updater(parseRightSidebarLayoutState(prev, fallback)),
    defaultLayout
  );
};

const findFirstTerminalSessionTab = (
  node: ReturnType<typeof parseRightSidebarLayoutState>["root"]
): { tabsetId: string; tab: TabType } | null => {
  if (node.type === "tabset") {
    const tab = node.tabs.find((t) => t.startsWith("terminal:") && t !== "terminal");
    return tab ? { tabsetId: node.id, tab } : null;
  }

  return (
    findFirstTerminalSessionTab(node.children[0]) ?? findFirstTerminalSessionTab(node.children[1])
  );
};
export function buildCoreSources(p: BuildSourcesParams): Array<() => CommandAction[]> {
  const actions: Array<() => CommandAction[]> = [];

  // NOTE: We intentionally route to the chat-based creation flow instead of
  // building a separate prompt. This keeps `/new`, keybinds, and the command
  // palette perfectly aligned on one experience.
  const createWorkspaceForSelectedProjectAction = (
    selected: NonNullable<BuildSourcesParams["selectedWorkspace"]>
  ): CommandAction => {
    return {
      id: CommandIds.workspaceNew(),
      title: "Create New Workspace…",
      subtitle: `for ${selected.projectName}`,
      section: section.workspaces,
      shortcutHint: formatKeybind(KEYBINDS.NEW_WORKSPACE),
      run: () => p.onStartWorkspaceCreation(selected.projectPath),
    };
  };

  // Workspaces
  actions.push(() => {
    const list: CommandAction[] = [];

    const selected = p.selectedWorkspace;
    if (selected) {
      list.push(createWorkspaceForSelectedProjectAction(selected));
    }

    // Switch to workspace
    // Iterate through all workspace metadata (now keyed by workspace ID)
    for (const meta of p.workspaceMetadata.values()) {
      const isCurrent = selected?.workspaceId === meta.id;
      const isStreaming = p.streamingModels?.has(meta.id) ?? false;
      list.push({
        id: CommandIds.workspaceSwitch(meta.id),
        title: `${isCurrent ? "• " : ""}Switch to ${meta.name}`,
        subtitle: `${meta.projectName}${isStreaming ? " • streaming" : ""}`,
        section: section.workspaces,
        keywords: [meta.name, meta.projectName, meta.namedWorkspacePath, meta.title].filter(
          (k): k is string => !!k
        ),
        run: () =>
          p.onSelectWorkspace({
            projectPath: meta.projectPath,
            projectName: meta.projectName,
            namedWorkspacePath: meta.namedWorkspacePath,
            workspaceId: meta.id,
          }),
      });
    }

    // Remove current workspace (rename action intentionally omitted until we add a proper modal)
    if (selected?.namedWorkspacePath) {
      const workspaceDisplayName = `${selected.projectName}/${selected.namedWorkspacePath.split("/").pop() ?? selected.namedWorkspacePath}`;
      const selectedMeta = p.workspaceMetadata.get(selected.workspaceId);
      list.push({
        id: CommandIds.workspaceOpenTerminalCurrent(),
        title: "New Terminal Window",
        subtitle: workspaceDisplayName,
        section: section.workspaces,
        // Note: Cmd/Ctrl+T opens integrated terminal in sidebar (not shown here since this opens a popout)
        run: () => {
          p.onOpenWorkspaceInTerminal(selected.workspaceId, selectedMeta?.runtimeConfig);
        },
      });
      list.push({
        id: CommandIds.workspaceRemove(),
        title: "Remove Current Workspace…",
        subtitle: workspaceDisplayName,
        section: section.workspaces,
        run: async () => {
          const branchName =
            selectedMeta?.name ??
            selected.namedWorkspacePath.split("/").pop() ??
            selected.namedWorkspacePath;
          const ok = confirm(
            `Remove current workspace? This will delete the worktree and local branch "${branchName}". This cannot be undone.`
          );
          if (ok) await p.onRemoveWorkspace(selected.workspaceId);
        },
      });
      list.push({
        id: CommandIds.workspaceRename(),
        title: "Rename Current Workspace…",
        subtitle: workspaceDisplayName,
        section: section.workspaces,
        run: () => undefined,
        prompt: {
          title: "Rename Workspace",
          fields: [
            {
              type: "text",
              name: "newName",
              label: "New name",
              placeholder: "Enter new workspace name",
              // Use workspace metadata name (not path) for initial value
              initialValue: p.workspaceMetadata.get(selected.workspaceId)?.name ?? "",
              getInitialValue: () => p.workspaceMetadata.get(selected.workspaceId)?.name ?? "",
              validate: (v) => (!v.trim() ? "Name is required" : null),
            },
          ],
          onSubmit: async (vals) => {
            await p.onRenameWorkspace(selected.workspaceId, vals.newName.trim());
          },
        },
      });
    }

    if (p.workspaceMetadata.size > 0) {
      list.push({
        id: CommandIds.workspaceOpenTerminal(),
        title: "Open Terminal Window for Workspace…",
        section: section.workspaces,
        run: () => undefined,
        prompt: {
          title: "Open Terminal Window",
          fields: [
            {
              type: "select",
              name: "workspaceId",
              label: "Workspace",
              placeholder: "Search workspaces…",
              getOptions: () =>
                Array.from(p.workspaceMetadata.values()).map((meta) => {
                  // Use workspace name instead of extracting from path
                  const label = `${meta.projectName} / ${meta.name}`;
                  return {
                    id: meta.id,
                    label,
                    keywords: [
                      meta.name,
                      meta.projectName,
                      meta.namedWorkspacePath,
                      meta.id,
                      meta.title,
                    ].filter((k): k is string => !!k),
                  };
                }),
            },
          ],
          onSubmit: (vals) => {
            const meta = p.workspaceMetadata.get(vals.workspaceId);
            p.onOpenWorkspaceInTerminal(vals.workspaceId, meta?.runtimeConfig);
          },
        },
      });
      list.push({
        id: CommandIds.workspaceRenameAny(),
        title: "Rename Workspace…",
        section: section.workspaces,
        run: () => undefined,
        prompt: {
          title: "Rename Workspace",
          fields: [
            {
              type: "select",
              name: "workspaceId",
              label: "Select workspace",
              placeholder: "Search workspaces…",
              getOptions: () =>
                Array.from(p.workspaceMetadata.values()).map((meta) => {
                  const label = `${meta.projectName} / ${meta.name}`;
                  return {
                    id: meta.id,
                    label,
                    keywords: [
                      meta.name,
                      meta.projectName,
                      meta.namedWorkspacePath,
                      meta.id,
                      meta.title,
                    ].filter((k): k is string => !!k),
                  };
                }),
            },
            {
              type: "text",
              name: "newName",
              label: "New name",
              placeholder: "Enter new workspace name",
              getInitialValue: (values) => {
                const meta = Array.from(p.workspaceMetadata.values()).find(
                  (m) => m.id === values.workspaceId
                );
                return meta ? meta.name : "";
              },
              validate: (v) => (!v.trim() ? "Name is required" : null),
            },
          ],
          onSubmit: async (vals) => {
            await p.onRenameWorkspace(vals.workspaceId, vals.newName.trim());
          },
        },
      });
      list.push({
        id: CommandIds.workspaceRemoveAny(),
        title: "Remove Workspace…",
        section: section.workspaces,
        run: () => undefined,
        prompt: {
          title: "Remove Workspace",
          fields: [
            {
              type: "select",
              name: "workspaceId",
              label: "Select workspace",
              placeholder: "Search workspaces…",
              getOptions: () =>
                Array.from(p.workspaceMetadata.values()).map((meta) => {
                  const label = `${meta.projectName}/${meta.name}`;
                  return {
                    id: meta.id,
                    label,
                    keywords: [
                      meta.name,
                      meta.projectName,
                      meta.namedWorkspacePath,
                      meta.id,
                      meta.title,
                    ].filter((k): k is string => !!k),
                  };
                }),
            },
          ],
          onSubmit: async (vals) => {
            const meta = Array.from(p.workspaceMetadata.values()).find(
              (m) => m.id === vals.workspaceId
            );
            const workspaceName = meta ? `${meta.projectName}/${meta.name}` : vals.workspaceId;
            const branchName = meta?.name ?? workspaceName.split("/").pop() ?? workspaceName;
            const ok = confirm(
              `Remove workspace ${workspaceName}? This will delete the worktree and local branch "${branchName}". This cannot be undone.`
            );
            if (ok) {
              await p.onRemoveWorkspace(vals.workspaceId);
            }
          },
        },
      });
    }

    return list;
  });

  // Navigation / Interface
  actions.push(() => {
    const list: CommandAction[] = [
      {
        id: CommandIds.navNext(),
        title: "Next Workspace",
        section: section.navigation,
        shortcutHint: formatKeybind(KEYBINDS.NEXT_WORKSPACE),
        run: () => p.onNavigateWorkspace("next"),
      },
      {
        id: CommandIds.navPrev(),
        title: "Previous Workspace",
        section: section.navigation,
        shortcutHint: formatKeybind(KEYBINDS.PREV_WORKSPACE),
        run: () => p.onNavigateWorkspace("prev"),
      },
      {
        id: CommandIds.navToggleSidebar(),
        title: "Toggle Sidebar",
        section: section.navigation,
        shortcutHint: formatKeybind(KEYBINDS.TOGGLE_SIDEBAR),
        run: () => p.onToggleSidebar(),
      },
    ];

    // Right sidebar layout commands require a selected workspace (layout is per-workspace)
    const wsId = p.selectedWorkspace?.workspaceId;
    if (wsId) {
      list.push(
        {
          id: CommandIds.navRightSidebarFocusTerminal(),
          title: "Right Sidebar: Focus Terminal",
          section: section.navigation,
          run: () =>
            updateRightSidebarLayout(wsId, (s) => {
              const found = findFirstTerminalSessionTab(s.root);
              if (!found) return s;
              return selectTabInTabset(
                setFocusedTabset(s, found.tabsetId),
                found.tabsetId,
                found.tab
              );
            }),
        },
        {
          id: CommandIds.navRightSidebarSplitHorizontal(),
          title: "Right Sidebar: Split Horizontally",
          section: section.navigation,
          run: () => updateRightSidebarLayout(wsId, (s) => splitFocusedTabset(s, "horizontal")),
        },
        {
          id: CommandIds.navRightSidebarSplitVertical(),
          title: "Right Sidebar: Split Vertically",
          section: section.navigation,
          run: () => updateRightSidebarLayout(wsId, (s) => splitFocusedTabset(s, "vertical")),
        },
        {
          id: CommandIds.navRightSidebarAddTool(),
          title: "Right Sidebar: Add Tool…",
          section: section.navigation,
          run: () => undefined,
          prompt: {
            title: "Add Right Sidebar Tool",
            fields: [
              {
                type: "select",
                name: "tool",
                label: "Tool",
                placeholder: "Select a tool…",
                getOptions: () =>
                  (["costs", "review", "terminal"] as TabType[]).map((tab) => ({
                    id: tab,
                    label: tab === "costs" ? "Costs" : tab === "review" ? "Review" : "Terminal",
                    keywords: [tab],
                  })),
              },
            ],
            onSubmit: (vals) => {
              const tool = vals.tool;
              if (!isTabType(tool)) return;

              // "terminal" is now an alias for "focus an existing terminal session tab".
              // Creating new terminal sessions is handled in the main UI ("+" button).
              if (tool === "terminal") {
                updateRightSidebarLayout(wsId, (s) => {
                  const found = findFirstTerminalSessionTab(s.root);
                  if (!found) return s;
                  return selectTabInTabset(
                    setFocusedTabset(s, found.tabsetId),
                    found.tabsetId,
                    found.tab
                  );
                });
                return;
              }

              updateRightSidebarLayout(wsId, (s) => addToolToFocusedTabset(s, tool));
            },
          },
        }
      );
    }

    return list;
  });

  // Layout slots
  actions.push(() => {
    const list: CommandAction[] = [];
    const selected = p.selectedWorkspace;
    if (!selected) {
      return list;
    }

    const config = getLayoutsConfigOrDefault(p.layoutPresets);

    for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      const preset = getPresetForSlot(config, slot);
      const keybind = getEffectiveSlotKeybind(config, slot);
      assert(keybind, `Slot ${slot} must have a default keybind`);
      const shortcutHint = formatKeybind(keybind);

      list.push({
        id: CommandIds.layoutApplySlot(slot),
        title: `Layout: Apply Slot ${slot}`,
        subtitle: preset ? preset.name : "Empty",
        section: section.layouts,
        shortcutHint,
        enabled: () => Boolean(preset) && Boolean(p.onApplyLayoutSlot),
        run: () => {
          if (!preset) return;
          void p.onApplyLayoutSlot?.(selected.workspaceId, slot);
        },
      });

      if (p.onCaptureLayoutSlot) {
        list.push({
          id: CommandIds.layoutCaptureSlot(slot),
          title: `Layout: Capture current to Slot ${slot}…`,
          subtitle: preset ? preset.name : "Empty",
          section: section.layouts,
          run: () => undefined,
          prompt: {
            title: `Capture Layout Slot ${slot}`,
            fields: [
              {
                type: "text",
                name: "name",
                label: "Name",
                placeholder: `Slot ${slot}`,
                initialValue: preset ? preset.name : `Slot ${slot}`,
                getInitialValue: () => getPresetForSlot(config, slot)?.name ?? `Slot ${slot}`,
                validate: (v) => (!v.trim() ? "Name is required" : null),
              },
            ],
            onSubmit: async (vals) => {
              await p.onCaptureLayoutSlot?.(selected.workspaceId, slot, vals.name.trim());
            },
          },
        });
      }
    }

    return list;
  });

  // Appearance
  actions.push(() => {
    const list: CommandAction[] = [
      {
        id: CommandIds.themeToggle(),
        title: "Cycle Theme",
        section: section.appearance,
        run: () => p.onToggleTheme(),
      },
    ];

    // Add command for each theme the user isn't currently using
    for (const opt of THEME_OPTIONS) {
      if (p.theme !== opt.value) {
        list.push({
          id: CommandIds.themeSet(opt.value),
          title: `Use ${opt.label} Theme`,
          section: section.appearance,
          run: () => p.onSetTheme(opt.value),
        });
      }
    }

    return list;
  });

  // Chat utilities
  actions.push(() => {
    const list: CommandAction[] = [];
    if (p.selectedWorkspace) {
      const id = p.selectedWorkspace.workspaceId;
      list.push({
        id: CommandIds.chatClear(),
        title: "Clear History",
        section: section.chat,
        run: async () => {
          await p.api?.workspace.truncateHistory({ workspaceId: id, percentage: 1.0 });
        },
      });
      for (const pct of [0.75, 0.5, 0.25]) {
        list.push({
          id: CommandIds.chatTruncate(pct),
          title: `Truncate History to ${Math.round((1 - pct) * 100)}%`,
          section: section.chat,
          run: async () => {
            await p.api?.workspace.truncateHistory({ workspaceId: id, percentage: pct });
          },
        });
      }
      list.push({
        id: CommandIds.chatInterrupt(),
        title: "Interrupt Streaming",
        section: section.chat,
        run: async () => {
          if (p.selectedWorkspaceState?.awaitingUserQuestion) {
            return;
          }
          updatePersistedState(getAutoRetryKey(id), false);
          await p.api?.workspace.interruptStream({ workspaceId: id });
        },
      });
      list.push({
        id: CommandIds.chatJumpBottom(),
        title: "Jump to Bottom",
        section: section.chat,
        shortcutHint: formatKeybind(KEYBINDS.JUMP_TO_BOTTOM),
        run: () => {
          // Dispatch the keybind; AIView listens for it
          const ev = new KeyboardEvent("keydown", { key: "G", shiftKey: true });
          window.dispatchEvent(ev);
        },
      });
      list.push({
        id: CommandIds.chatVoiceInput(),
        title: "Toggle Voice Input",
        subtitle: "Dictate instead of typing",
        section: section.chat,
        shortcutHint: formatKeybind(KEYBINDS.TOGGLE_VOICE_INPUT),
        run: () => {
          // Dispatch custom event; ChatInput listens for it
          window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.TOGGLE_VOICE_INPUT));
        },
      });
      list.push({
        id: CommandIds.chatClearTimingStats(),
        title: "Clear Timing Stats",
        subtitle: "Reset session timing data for this workspace",
        section: section.chat,
        run: () => {
          p.onClearTimingStats?.(id);
        },
      });
    }
    return list;
  });

  // Modes & Model
  actions.push(() => {
    const list: CommandAction[] = [
      {
        id: CommandIds.modeToggle(),
        title: "Open Agent Picker",
        section: section.mode,
        shortcutHint: formatKeybind(KEYBINDS.TOGGLE_MODE),
        run: () => {
          window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_AGENT_PICKER));
        },
      },
      {
        id: "cycle-agent",
        title: "Cycle Agent",
        section: section.mode,
        shortcutHint: formatKeybind(KEYBINDS.CYCLE_AGENT),
        run: () => {
          const ev = new KeyboardEvent("keydown", { key: ".", ctrlKey: true });
          window.dispatchEvent(ev);
        },
      },
      {
        id: CommandIds.modelChange(),
        title: "Change Model…",
        section: section.mode,
        run: () => {
          window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR));
        },
      },
    ];

    const selectedWorkspace = p.selectedWorkspace;
    if (selectedWorkspace) {
      const { workspaceId } = selectedWorkspace;
      const levelDescriptions: Record<ThinkingLevel, string> = {
        off: "Off — fastest responses",
        low: "Low — add a bit of reasoning",
        medium: "Medium — balanced reasoning",
        high: "High — maximum reasoning depth",
        xhigh: "Extra High — extended deep thinking",
      };
      const currentLevel = p.getThinkingLevel(workspaceId);

      list.push({
        id: CommandIds.thinkingSetLevel(),
        title: "Set Thinking Effort…",
        subtitle: `Current: ${levelDescriptions[currentLevel] ?? currentLevel}`,
        section: section.mode,
        run: () => undefined,
        prompt: {
          title: "Select Thinking Effort",
          fields: [
            {
              type: "select",
              name: "thinkingLevel",
              label: "Thinking effort",
              placeholder: "Choose effort level…",
              getOptions: () =>
                THINKING_LEVELS.map((level) => ({
                  id: level,
                  label: levelDescriptions[level],
                  keywords: [
                    level,
                    levelDescriptions[level].toLowerCase(),
                    "thinking",
                    "reasoning",
                  ],
                })),
            },
          ],
          onSubmit: (vals) => {
            const rawLevel = vals.thinkingLevel;
            const level = THINKING_LEVELS.includes(rawLevel as ThinkingLevel)
              ? (rawLevel as ThinkingLevel)
              : "off";
            p.onSetThinkingLevel(workspaceId, level);
          },
        },
      });
    }

    return list;
  });

  // Help / Docs
  actions.push(() => [
    {
      id: CommandIds.helpKeybinds(),
      title: "Show Keyboard Shortcuts",
      section: section.help,
      run: () => {
        try {
          window.open("https://mux.coder.com/config/keybinds", "_blank");
        } catch {
          /* ignore */
        }
      },
    },
  ]);

  // Projects
  actions.push(() => {
    const list: CommandAction[] = [
      {
        id: CommandIds.projectAdd(),
        title: "Add Project…",
        section: section.projects,
        run: () => p.onAddProject(),
      },
      {
        id: CommandIds.workspaceNewInProject(),
        title: "Create New Workspace in Project…",
        section: section.projects,
        run: () => undefined,
        prompt: {
          title: "New Workspace in Project",
          fields: [
            {
              type: "select",
              name: "projectPath",
              label: "Select project",
              placeholder: "Search projects…",
              getOptions: (_values) =>
                Array.from(p.projects.keys()).map((projectPath) => ({
                  id: projectPath,
                  label: projectPath.split("/").pop() ?? projectPath,
                  keywords: [projectPath],
                })),
            },
          ],
          onSubmit: (vals) => {
            const projectPath = vals.projectPath;
            // Reuse the chat-based creation flow for the selected project
            p.onStartWorkspaceCreation(projectPath);
          },
        },
      },
    ];

    for (const [projectPath] of p.projects.entries()) {
      const projectName = projectPath.split("/").pop() ?? projectPath;
      list.push({
        id: CommandIds.projectRemove(projectPath),
        title: `Remove Project ${projectName}…`,
        section: section.projects,
        run: () => p.onRemoveProject(projectPath),
      });
    }
    return list;
  });

  // Settings
  if (p.onOpenSettings) {
    const openSettings = p.onOpenSettings;
    actions.push(() => [
      {
        id: CommandIds.settingsOpen(),
        title: "Open Settings",
        section: section.settings,
        keywords: ["preferences", "config", "configuration"],
        shortcutHint: "⌘,",
        run: () => openSettings(),
      },
      {
        id: CommandIds.settingsOpenSection("providers"),
        title: "Settings: Providers",
        subtitle: "Configure API keys and endpoints",
        section: section.settings,
        keywords: ["api", "key", "anthropic", "openai", "google"],
        run: () => openSettings("providers"),
      },
      {
        id: CommandIds.settingsOpenSection("models"),
        title: "Settings: Models",
        subtitle: "Manage custom models",
        section: section.settings,
        keywords: ["model", "custom", "add"],
        run: () => openSettings("models"),
      },
    ]);
  }

  return actions;
}
