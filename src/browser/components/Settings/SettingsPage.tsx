import { useEffect } from "react";
import {
  ArrowLeft,
  Menu,
  Settings,
  Key,
  Cpu,
  X,
  FlaskConical,
  Bot,
  Keyboard,
  Layout,
  Container,
  BrainCircuit,
  Shield,
  ShieldCheck,
  Server,
  Lock,
} from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useOnboardingPause } from "@/browser/components/splashScreens/SplashScreenProvider";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { GeneralSection } from "./sections/GeneralSection";
import { TasksSection } from "./sections/TasksSection";
import { ProvidersSection } from "./sections/ProvidersSection";
import { ModelsSection } from "./sections/ModelsSection";
import { System1Section } from "./sections/System1Section";
import { GovernorSection } from "./sections/GovernorSection";
import { Button } from "@/browser/components/Button/Button";
import { MCPSettingsSection } from "./sections/MCPSettingsSection";
import { SecretsSection } from "./sections/SecretsSection";
import { LayoutsSection } from "./sections/LayoutsSection";
import { RuntimesSection } from "./sections/RuntimesSection";
import { ExperimentsSection } from "./sections/ExperimentsSection";
import { ServerAccessSection } from "./sections/ServerAccessSection";
import { KeybindsSection } from "./sections/KeybindsSection";
import { SecuritySection } from "./sections/SecuritySection";
import type { SettingsSection } from "./types";

const BASE_SECTIONS: SettingsSection[] = [
  {
    id: "general",
    label: "General",
    icon: <Settings className="h-4 w-4" />,
    component: GeneralSection,
  },
  {
    id: "tasks",
    label: "Agents",
    icon: <Bot className="h-4 w-4" />,
    component: TasksSection,
  },
  {
    id: "providers",
    label: "Providers",
    icon: <Key className="h-4 w-4" />,
    component: ProvidersSection,
  },
  {
    id: "models",
    label: "Models",
    icon: <Cpu className="h-4 w-4" />,
    component: ModelsSection,
  },
  {
    id: "mcp",
    label: "MCP",
    icon: <Server className="h-4 w-4" />,
    component: MCPSettingsSection,
  },
  {
    id: "secrets",
    label: "Secrets",
    icon: <Lock className="h-4 w-4" />,
    component: SecretsSection,
  },
  {
    id: "security",
    label: "Security",
    icon: <ShieldCheck className="h-4 w-4" />,
    component: SecuritySection,
  },
  {
    id: "server-access",
    label: "Server Access",
    icon: <Shield className="h-4 w-4" />,
    component: ServerAccessSection,
  },
  {
    id: "layouts",
    label: "Layouts",
    icon: <Layout className="h-4 w-4" />,
    component: LayoutsSection,
  },
  {
    id: "runtimes",
    label: "Runtimes",
    icon: <Container className="h-4 w-4" />,
    component: RuntimesSection,
  },
  {
    id: "experiments",
    label: "Experiments",
    icon: <FlaskConical className="h-4 w-4" />,
    component: ExperimentsSection,
  },
  {
    id: "keybinds",
    label: "Keybinds",
    icon: <Keyboard className="h-4 w-4" />,
    component: KeybindsSection,
  },
];

interface SettingsPageProps {
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
}

export function SettingsPage(props: SettingsPageProps) {
  const { close, activeSection, setActiveSection } = useSettings();
  const onboardingPause = useOnboardingPause();
  const system1Enabled = useExperimentValue(EXPERIMENT_IDS.SYSTEM_1);
  const governorEnabled = useExperimentValue(EXPERIMENT_IDS.MUX_GOVERNOR);

  // Keep routing on a valid section when an experiment-gated section is disabled.
  useEffect(() => {
    if (!system1Enabled && activeSection === "system1") {
      setActiveSection(BASE_SECTIONS[0]?.id ?? "general");
    }
    if (!governorEnabled && activeSection === "governor") {
      setActiveSection(BASE_SECTIONS[0]?.id ?? "general");
    }
  }, [activeSection, setActiveSection, system1Enabled, governorEnabled]);

  // Close settings on Escape. Uses bubble phase so inner surfaces (Select dropdowns,
  // Popover, Dialog) that call stopPropagation/preventDefault on Escape get first
  // right of refusal—only an unclaimed Escape navigates away from settings.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.CANCEL)) return;
      if (e.defaultPrevented) return;
      if (isEditableElement(e.target)) return;

      e.preventDefault();
      e.stopPropagation();
      close();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);
  let sections: SettingsSection[] = BASE_SECTIONS;
  if (system1Enabled) {
    sections = [
      ...sections,
      {
        id: "system1",
        label: "System 1",
        icon: <BrainCircuit className="h-4 w-4" />,
        component: System1Section,
      },
    ];
  }
  if (governorEnabled) {
    sections = [
      ...sections,
      {
        id: "governor",
        label: "Governor",
        icon: <ShieldCheck className="h-4 w-4" />,
        component: GovernorSection,
      },
    ];
  }

  const currentSection = sections.find((section) => section.id === activeSection) ?? sections[0];
  const SectionComponent = currentSection.component;

  return (
    <div className="bg-dark flex min-h-0 flex-1 flex-col overflow-hidden">
      {/*
        Keep explicit mobile escape controls in the page chrome:
        - The desktop close button is hidden below md.
        - On touch layouts, the left sidebar is often off-canvas by default.
        Without back + menu actions here, /settings/:section can trap users in-pane.
      */}
      <div className="bg-sidebar border-border-light flex shrink-0 items-center justify-between border-b px-2 md:hidden [@media(max-width:768px)]:h-auto [@media(max-width:768px)]:py-2">
        <div className="flex min-w-0 items-center gap-2">
          {props.leftSidebarCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onToggleLeftSidebarCollapsed}
              title="Open sidebar"
              aria-label="Open sidebar menu"
              className="mobile-menu-btn text-muted hover:text-foreground hidden h-6 w-6 shrink-0"
            >
              <Menu className="h-4 w-4" />
            </Button>
          )}
          <span className="text-foreground text-sm font-semibold">Settings</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={close}
          title="Back"
          aria-label="Back to previous page"
          className="text-muted hover:text-foreground px-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="border-border-medium hidden w-48 shrink-0 flex-col border-r md:flex">
          <div className="border-border-medium flex h-12 items-center border-b px-4">
            <span className="text-foreground text-sm font-semibold">Settings</span>
          </div>
          <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
            {sections.map((section) => (
              <Button
                key={section.id}
                variant="ghost"
                onClick={() => setActiveSection(section.id)}
                className={`flex h-auto w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-left text-sm ${
                  activeSection === section.id
                    ? "bg-accent/20 text-accent hover:bg-accent/20 hover:text-accent"
                    : "text-muted hover:bg-hover hover:text-foreground"
                }`}
              >
                {section.icon}
                {section.label}
              </Button>
            ))}
          </nav>
        </aside>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="border-border-medium shrink-0 border-b md:hidden">
            <nav className="flex gap-1 overflow-x-auto p-2">
              {sections.map((section) => (
                <Button
                  key={section.id}
                  variant="ghost"
                  onClick={() => setActiveSection(section.id)}
                  className={`flex h-auto shrink-0 items-center justify-start gap-2 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap ${
                    activeSection === section.id
                      ? "bg-accent/20 text-accent hover:bg-accent/20 hover:text-accent"
                      : "text-muted hover:bg-hover hover:text-foreground"
                  }`}
                >
                  {section.icon}
                  {section.label}
                </Button>
              ))}
            </nav>
          </div>

          <div className="border-border-medium hidden h-12 items-center justify-between border-b px-6 md:flex">
            <span className="text-foreground text-sm font-medium">{currentSection.label}</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={close}
              className="h-6 w-6"
              aria-label="Close settings"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            {/* Keep settings content width bounded so long forms remain readable on wide screens. */}
            <div className="w-full max-w-4xl">
              {onboardingPause.paused && (
                <div className="bg-accent/10 border-accent/30 text-foreground mb-3 flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span>Setup is paused while you configure providers.</span>
                  <Button variant="secondary" size="sm" onClick={close}>
                    Return to setup
                  </Button>
                </div>
              )}
              <SectionComponent />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
