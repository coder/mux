import React from "react";
import {
  Settings,
  Key,
  Cpu,
  X,
  FlaskConical,
  Bot,
  Keyboard,
  Layout,
  BrainCircuit,
  ShieldCheck,
  Server,
  Lock,
} from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { GeneralSection } from "./sections/GeneralSection";
import { TasksSection } from "./sections/TasksSection";
import { ProvidersSection } from "./sections/ProvidersSection";
import { ModelsSection } from "./sections/ModelsSection";
import { System1Section } from "./sections/System1Section";
import { GovernorSection } from "./sections/GovernorSection";
import { Button } from "@/browser/components/ui/button";
import { MCPSettingsSection } from "./sections/MCPSettingsSection";
import { SecretsSection } from "./sections/SecretsSection";
import { LayoutsSection } from "./sections/LayoutsSection";
import { ExperimentsSection } from "./sections/ExperimentsSection";
import { KeybindsSection } from "./sections/KeybindsSection";
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
    id: "layouts",
    label: "Layouts",
    icon: <Layout className="h-4 w-4" />,
    component: LayoutsSection,
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

export function SettingsPage(_props: SettingsPageProps) {
  const { close, activeSection, setActiveSection } = useSettings();
  const system1Enabled = useExperimentValue(EXPERIMENT_IDS.SYSTEM_1);
  const governorEnabled = useExperimentValue(EXPERIMENT_IDS.MUX_GOVERNOR);

  // Keep routing on a valid section when an experiment-gated section is disabled.
  React.useEffect(() => {
    if (!system1Enabled && activeSection === "system1") {
      setActiveSection(BASE_SECTIONS[0]?.id ?? "general");
    }
    if (!governorEnabled && activeSection === "governor") {
      setActiveSection(BASE_SECTIONS[0]?.id ?? "general");
    }
  }, [activeSection, setActiveSection, system1Enabled, governorEnabled]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 MARKER_XYZ_123" onClick={close}>
      <div
        className="relative flex h-[80vh] w-[min(900px,90vw)] overflow-hidden rounded-xl border border-border-medium bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left nav */}
        <aside className="flex w-52 shrink-0 flex-col border-r border-border-medium">
          <div className="flex h-12 items-center px-4">
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

        {/* Content area */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-12 items-center justify-between border-b border-border-medium px-6">
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
          <div className="flex-1 overflow-y-auto p-6">
            <SectionComponent />
          </div>
        </div>
      </div>
    </div>
  );
}
// UNIQUE_BUILD_TOKEN_1771372627
