import type { Meta, StoryObj } from "@storybook/react-vite";
import { action } from "storybook/actions";
import { CommandPalette } from "./CommandPalette";
import { CommandRegistryProvider } from "@/browser/contexts/CommandRegistryContext";
import type { CommandAction } from "@/browser/contexts/CommandRegistryContext";
import { useEffect } from "react";
import { useCommandRegistry } from "@/browser/contexts/CommandRegistryContext";

// Mock command actions for the demo
const mockCommands: CommandAction[] = [
  {
    id: "workspace.create",
    title: "Create New Workspace",
    subtitle: "Start a new workspace in this project",
    section: "Workspaces",
    keywords: ["new", "add", "workspace"],
    shortcutHint: "⌘N",
    run: () => action("command-executed")("workspace.create"),
  },
  {
    id: "workspace.switch",
    title: "Switch Workspace",
    subtitle: "Navigate to a different workspace",
    section: "Workspaces",
    keywords: ["change", "go to", "workspace"],
    shortcutHint: "⌘P",
    run: () => action("command-executed")("workspace.switch"),
  },
  {
    id: "workspace.delete",
    title: "Delete Workspace",
    subtitle: "Remove the current workspace",
    section: "Workspaces",
    keywords: ["remove", "delete", "workspace"],
    run: () => action("command-executed")("workspace.delete"),
  },
  {
    id: "chat.clear",
    title: "Clear Chat History",
    subtitle: "Remove all messages from current chat",
    section: "Chat",
    keywords: ["clear", "delete", "history", "messages"],
    run: () => action("command-executed")("chat.clear"),
  },
  {
    id: "chat.export",
    title: "Export Chat",
    subtitle: "Export conversation to file",
    section: "Chat",
    keywords: ["export", "save", "download"],
    run: () => action("command-executed")("chat.export"),
  },
  {
    id: "mode.toggle",
    title: "Toggle Mode",
    subtitle: "Switch between Plan and Exec modes",
    section: "Mode",
    keywords: ["mode", "switch", "plan", "exec"],
    shortcutHint: "⌘⇧M",
    run: () => action("command-executed")("mode.toggle"),
  },
  {
    id: "thinking.cycle",
    title: "Cycle Thinking Level",
    subtitle: "Change AI thinking intensity",
    section: "Settings",
    keywords: ["thinking", "level", "cycle"],
    shortcutHint: "⌘⇧T",
    run: () => action("command-executed")("thinking.cycle"),
  },
  {
    id: "model.change",
    title: "Change Model",
    subtitle: "Select a different AI model",
    section: "Settings",
    keywords: ["model", "ai", "change", "switch"],
    shortcutHint: "⌘⇧K",
    run: () => action("command-executed")("model.change"),
  },
  {
    id: "project.add",
    title: "Add Project",
    subtitle: "Add a new project to sidebar",
    section: "Project",
    keywords: ["add", "new", "project"],
    run: () => action("command-executed")("project.add"),
  },
  {
    id: "project.remove",
    title: "Remove Project",
    subtitle: "Remove project from sidebar",
    section: "Project",
    keywords: ["remove", "delete", "project"],
    run: () => action("command-executed")("project.remove"),
  },
  {
    id: "help.keybinds",
    title: "Show Keyboard Shortcuts",
    subtitle: "View all available keybindings",
    section: "Help",
    keywords: ["help", "shortcuts", "keybinds", "keys"],
    shortcutHint: "⌘/",
    run: () => action("command-executed")("help.keybinds"),
  },
  {
    id: "help.docs",
    title: "Open Documentation",
    subtitle: "View cmux documentation",
    section: "Help",
    keywords: ["help", "docs", "documentation"],
    run: () => action("command-executed")("help.docs"),
  },
];

// Component that registers mock commands and opens the palette
const PaletteDemo: React.FC<{ autoOpen?: boolean }> = ({ autoOpen = true }) => {
  const { registerSource, open } = useCommandRegistry();

  useEffect(() => {
    // Register mock command source
    const unregister = registerSource(() => mockCommands);

    // Auto-open palette for demo
    if (autoOpen) {
      setTimeout(() => open(), 100);
    }

    return unregister;
  }, [registerSource, open, autoOpen]);

  return (
    <>
      <button
        onClick={() => open()}
        className="bg-accent-dark font-primary hover:bg-accent-hover active:bg-accent-dark cursor-pointer self-start rounded border-none px-4 py-2 text-[13px] text-white"
      >
        Open Command Palette (⌘⇧P)
      </button>
      <CommandPalette
        getSlashContext={() => ({
          providerNames: ["anthropic", "openai", "google"],
          workspaceId: "demo-workspace",
        })}
      />
    </>
  );
};

const meta = {
  title: "Components/CommandPalette",
  component: CommandPalette,
  parameters: {
    layout: "fullscreen",
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#1e1e1e" }],
    },
    controls: {
      exclude: ["getSlashContext"],
    },
  },
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <CommandRegistryProvider>
        <Story />
      </CommandRegistryProvider>
    ),
  ],
} satisfies Meta<typeof CommandPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="bg-dark flex min-h-[600px] flex-col gap-5 p-5">
      <div className="bg-separator border-border-light text-bright font-primary [&_kbd]:bg-dark [&_kbd]:border-border-light [&_kbd]:font-monospace rounded border p-4 text-[13px] leading-[1.6] [&_kbd]:rounded-[3px] [&_kbd]:border [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:text-[11px]">
        <strong>Command Palette</strong>
        <br />
        <br />
        The command palette is automatically opened for demonstration. Click the button below to
        reopen it.
        <br />
        <br />
        <strong>Two Modes:</strong>
        <br />• <strong>Default</strong>: Workspace switcher (only shows switching commands)
        <br />•{" "}
        <strong>
          Type <kbd>&gt;</kbd>
        </strong>
        : Command mode (shows all other commands)
        <br />•{" "}
        <strong>
          Type <kbd>/</kbd>
        </strong>
        : Slash commands for chat input
        <br />
        <br />
        • Use ↑↓ arrow keys to navigate, Enter to execute
        <br />
        • Press Escape to close
        <br />• Commands organized into sections (Workspaces, Chat, Mode, Settings, Project, Help)
      </div>
      <PaletteDemo />
    </div>
  ),
};
