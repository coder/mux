import React, { useMemo, useState } from "react";
import { ArrowLeft, Bot, Command as CommandIcon, Server, Boxes, Sparkles } from "lucide-react";
import { SplashScreen } from "./SplashScreen";
import { ProviderWithIcon } from "@/browser/components/ProviderIcon";
import { DocsLink } from "@/browser/components/DocsLink";
import {
  LocalIcon,
  WorktreeIcon,
  SSHIcon,
  DockerIcon,
} from "@/browser/components/icons/RuntimeIcons";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";

const KBD_CLASSNAME =
  "bg-background-secondary text-foreground border-border-medium rounded border px-2 py-0.5 font-mono text-xs";

type Direction = "forward" | "back";

function ProgressDots(props: { count: number; activeIndex: number }) {
  return (
    <div
      className="flex items-center gap-1"
      aria-label={`Step ${props.activeIndex + 1} of ${props.count}`}
    >
      {Array.from({ length: props.count }).map((_, i) => (
        <span
          key={`dot-${i}`}
          className={`h-1.5 w-1.5 rounded-full ${
            i === props.activeIndex ? "bg-accent" : "bg-border-medium"
          }`}
        />
      ))}
    </div>
  );
}

function WizardHeader(props: {
  stepIndex: number;
  totalSteps: number;
  onBack: () => void;
  hasBack: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      {props.hasBack ? (
        <button
          type="button"
          className="text-muted hover:text-foreground inline-flex items-center gap-1 text-xs"
          onClick={props.onBack}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">
        <span className="text-muted text-xs">
          {props.stepIndex + 1} / {props.totalSteps}
        </span>
        <ProgressDots count={props.totalSteps} activeIndex={props.stepIndex} />
      </div>
    </div>
  );
}

function Card(props: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-background-secondary border-border-medium rounded-lg border p-3 ${
        props.className ?? ""
      }`}
    >
      <div className="text-foreground flex items-center gap-2 text-sm font-medium">
        <span className="bg-accent/10 text-accent inline-flex h-7 w-7 items-center justify-center rounded-md">
          {props.icon}
        </span>
        {props.title}
      </div>
      <div className="text-muted mt-2 text-sm">{props.children}</div>
    </div>
  );
}

function CommandPalettePreview(props: { shortcut: string }) {
  return (
    <div
      className="font-primary overflow-hidden rounded-lg border border-[var(--color-command-border)] bg-[var(--color-command-surface)] text-[var(--color-command-foreground)]"
      aria-label="Command palette preview"
    >
      <div className="border-b border-[var(--color-command-input-border)] bg-[var(--color-command-input)] px-3.5 py-3 text-sm">
        <span className="text-[var(--color-command-subdued)]">
          Switch workspaces or type <span className="font-mono">&gt;</span> for all commands…
        </span>
      </div>

      <div className="px-1.5 py-2">
        <div className="px-2.5 py-1 text-[11px] tracking-[0.08em] text-[var(--color-command-subdued)] uppercase">
          Recent
        </div>

        <div className="hover:bg-hover mx-1 my-0.5 grid grid-cols-[1fr_auto] items-center gap-2 rounded-md px-3 py-2 text-[13px]">
          <div>
            Create New Workspace…
            <br />
            <span className="text-xs text-[var(--color-command-subdued)]">
              Start a new workspace (Local / Worktree / SSH / Docker)
            </span>
          </div>
          <span className="font-monospace text-[11px] text-[var(--color-command-subdued)]">
            &gt;new
          </span>
        </div>

        <div className="bg-hover mx-1 my-0.5 grid grid-cols-[1fr_auto] items-center gap-2 rounded-md px-3 py-2 text-[13px]">
          <div>
            Open Settings…
            <br />
            <span className="text-xs text-[var(--color-command-subdued)]">
              Jump to providers, models, MCP…
            </span>
          </div>
          <span className="font-monospace text-[11px] text-[var(--color-command-subdued)]">
            &gt;settings
          </span>
        </div>

        <div className="hover:bg-hover mx-1 my-0.5 grid grid-cols-[1fr_auto] items-center gap-2 rounded-md px-3 py-2 text-[13px]">
          <div>
            Help: Keybinds
            <br />
            <span className="text-xs text-[var(--color-command-subdued)]">
              Discover shortcuts for the whole app
            </span>
          </div>
          <span className="font-monospace text-[11px] text-[var(--color-command-subdued)]">
            {props.shortcut}
          </span>
        </div>
      </div>
    </div>
  );
}

export function OnboardingWizardSplash(props: { onDismiss: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<Direction>("forward");

  const commandPaletteShortcut = formatKeybind(KEYBINDS.OPEN_COMMAND_PALETTE);
  const agentPickerShortcut = formatKeybind(KEYBINDS.TOGGLE_MODE);
  const cycleAgentShortcut = formatKeybind(KEYBINDS.CYCLE_AGENT);

  const steps = useMemo(
    () =>
      [
        {
          key: "providers",
          title: "Choose your own AI providers",
          icon: <Sparkles className="h-4 w-4" />,
          body: (
            <>
              <p>
                Mux is provider-agnostic: bring your own keys, mix and match models, or run locally.
              </p>

              <div className="mt-3">
                <div className="text-foreground mb-2 text-xs font-medium">Available providers</div>
                <div className="grid grid-cols-2 gap-2">
                  {SUPPORTED_PROVIDERS.map((provider) => (
                    <div
                      key={provider}
                      className="bg-background-secondary border-border-medium text-foreground flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
                    >
                      <ProviderWithIcon
                        provider={provider}
                        displayName
                        iconClassName="text-accent"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <p className="mt-3">
                Configure keys and endpoints in{" "}
                <span className="text-foreground">Settings → Providers</span>.
              </p>
            </>
          ),
        },
        {
          key: "agents",
          title: "Agents: Plan, Exec, and custom",
          icon: <Bot className="h-4 w-4" />,
          body: (
            <>
              <p>
                Agents are file-based definitions (system prompt + tool policy). You can create
                project-local agents in <code className="text-accent">.mux/agents/*.md</code> or
                global agents in <code className="text-accent">~/.mux/agents/*.md</code>.
              </p>

              <div className="mt-3 grid gap-2">
                <Card icon={<Sparkles className="h-4 w-4" />} title="Use Plan to design the spec">
                  When the change is complex, switch to a plan-like agent first: write an explicit
                  plan (files, steps, risks), then execute.
                </Card>

                <Card icon={<Bot className="h-4 w-4" />} title="Quick shortcuts">
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span>Agent picker</span>
                    <kbd className={KBD_CLASSNAME}>{agentPickerShortcut}</kbd>
                    <span className="text-muted mx-1">•</span>
                    <span>Cycle agent</span>
                    <kbd className={KBD_CLASSNAME}>{cycleAgentShortcut}</kbd>
                  </div>
                </Card>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <DocsLink path="/agents">Agent docs</DocsLink>
                <DocsLink path="/agents/plan-mode">Plan mode</DocsLink>
              </div>
            </>
          ),
        },
        {
          key: "runtimes",
          title: "Multiple runtimes",
          icon: <Boxes className="h-4 w-4" />,
          body: (
            <>
              <p>
                Each workspace can run in the environment that fits the job: keep it local, isolate
                with a git worktree, run remotely over SSH, or use a per-workspace Docker container.
              </p>

              <div className="mt-3 grid gap-2">
                <Card icon={<LocalIcon size={14} />} title="Local">
                  Work directly in your project directory.
                </Card>
                <Card icon={<WorktreeIcon size={14} />} title="Worktree">
                  Isolated git worktree under <code className="text-accent">~/.mux/src</code>.
                </Card>
                <Card icon={<SSHIcon size={14} />} title="SSH">
                  Remote clone and commands run on an SSH host.
                </Card>
                <Card icon={<DockerIcon size={14} />} title="Docker">
                  Isolated container per workspace.
                </Card>
              </div>

              <p className="mt-3">
                You can set a project default runtime in the workspace creation controls.
              </p>
            </>
          ),
        },
        {
          key: "mcp",
          title: "MCP servers",
          icon: <Server className="h-4 w-4" />,
          body: (
            <>
              <p>
                MCP servers extend Mux with tools (memory, ticketing, databases, internal APIs).
                Configure them per project and optionally override per workspace.
              </p>

              <div className="mt-3 grid gap-2">
                <Card icon={<Server className="h-4 w-4" />} title="Project config">
                  <code className="text-accent">.mux/mcp.jsonc</code>
                </Card>
                <Card icon={<Server className="h-4 w-4" />} title="Workspace overrides">
                  <code className="text-accent">.mux/mcp.local.jsonc</code>
                </Card>
              </div>

              <p className="mt-3">
                Manage servers in <span className="text-foreground">Settings → Projects</span> or
                via <code className="text-accent">/mcp</code>.
              </p>
            </>
          ),
        },
        {
          key: "palette",
          title: "Command palette",
          icon: <CommandIcon className="h-4 w-4" />,
          body: (
            <>
              <p>
                The command palette is the fastest way to navigate, create workspaces, and discover
                features.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-muted text-sm">Open command palette</span>
                <kbd className={KBD_CLASSNAME}>{commandPaletteShortcut}</kbd>
              </div>

              <div className="mt-3">
                <CommandPalettePreview shortcut={commandPaletteShortcut} />
              </div>

              <p className="mt-3">
                Tip: type <code className="text-accent">&gt;</code> for commands and{" "}
                <code className="text-accent">/</code> for slash commands.
              </p>
            </>
          ),
        },
      ] as const,
    [agentPickerShortcut, cycleAgentShortcut, commandPaletteShortcut]
  );

  const totalSteps = steps.length;
  const currentStep = steps[stepIndex];

  const canGoBack = stepIndex > 0;
  const canGoForward = stepIndex < totalSteps - 1;

  const goBack = () => {
    if (!canGoBack) {
      return;
    }
    setDirection("back");
    setStepIndex((i) => Math.max(0, i - 1));
  };

  const goForward = () => {
    if (!canGoForward) {
      return;
    }
    setDirection("forward");
    setStepIndex((i) => Math.min(totalSteps - 1, i + 1));
  };

  return (
    <SplashScreen
      title={currentStep.title}
      onDismiss={props.onDismiss}
      dismissLabel="Skip"
      dismissOnPrimaryAction={false}
      primaryAction={{
        label: canGoForward ? "Next" : "Done",
        onClick: () => {
          if (canGoForward) {
            goForward();
            return;
          }
          props.onDismiss();
        },
      }}
    >
      <div className="text-muted flex flex-col gap-4">
        <WizardHeader
          stepIndex={stepIndex}
          totalSteps={totalSteps}
          hasBack={canGoBack}
          onBack={goBack}
        />

        <div
          key={currentStep.key}
          className={`flex flex-col gap-3 ${
            direction === "forward"
              ? "animate-in fade-in-0 slide-in-from-right-2"
              : "animate-in fade-in-0 slide-in-from-left-2"
          }`}
        >
          <div className="text-foreground flex items-center gap-2 text-sm font-medium">
            <span className="bg-accent/10 text-accent inline-flex h-8 w-8 items-center justify-center rounded-md">
              {currentStep.icon}
            </span>
            <span>{currentStep.title}</span>
          </div>

          <div className="text-muted flex flex-col gap-3 text-sm">{currentStep.body}</div>
        </div>
      </div>
    </SplashScreen>
  );
}
